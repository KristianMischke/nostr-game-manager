#!/usr/bin/env node
/**
 * `nip-gm` — run a GM from a config file.
 *
 * A thin wrapper over `createGM` for the case where you want to host a
 * *published* game module without writing any code: the config names module
 * packages, this resolves them with dynamic `import()`, builds the signer, and
 * starts.
 *
 * ## The key is not in the config, deliberately
 *
 * There is no config field for the GM secret key and there will not be one. It
 * is read from `GM_NSEC` or from a file named by `--key`, because config files
 * get committed, pasted into issues, and copied between machines, and a GM key
 * is the identity every audit of every game it ran is attributed to. Losing it
 * is not "rotate a credential" — it is someone else authoring history under your
 * name.
 *
 * ## The adapter is named by config, not imported
 *
 * `nip-gm-gm` does not depend on `nip-gm-nostr`. The dependency graph runs
 * core → {client, gm, nostr, testing} with no edges between siblings, and a
 * daemon that hard-imported one relay library would both break that and pin
 * every operator to it. The adapter package is named in the config and resolved
 * at runtime, so hosting over NDK, over `nostr-tools`, or over something that
 * does not exist yet is a config change.
 */
import { readFile } from 'node:fs/promises';
import { createGM } from '../gm.js';
import type { AnyGameModule, KeySigner, Transport } from 'nip-gm-core';
import type { GMPolicy } from '../policy.js';
import type { LobbyDefaults } from '../lobby-manager.js';

interface GMConfig {
  /** npm package names or paths exporting a `GameModule`. */
  modules: string[];
  relays: string[];
  policy: GMPolicy;
  lobbyDefaults?: Partial<LobbyDefaults>;
  /**
   * Package providing the relay binding, resolved at runtime. It must export
   * `createTransport({ relays })` and `createKeySigner(secret)`.
   */
  adapter?: string;
}

/** The shape a transport adapter package must expose to be hostable. */
interface TransportAdapter {
  createTransport(options: { relays: string[] }): Transport;
  createKeySigner(secret: string): KeySigner;
}

interface Args {
  config: string;
  key?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { config: 'nip-gm.config.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') args.config = argv[++i];
    else if (argv[i] === '--key' || argv[i] === '-k') args.key = argv[++i];
  }
  return args;
}

/**
 * Resolve the GM secret key.
 *
 * Order is `--key <file>` then `GM_NSEC`, and nothing else — in particular not
 * the config file. See the note at the top.
 */
async function loadSecretKey(keyFile?: string): Promise<string> {
  if (keyFile) return (await readFile(keyFile, 'utf8')).trim();
  const fromEnv = process.env.GM_NSEC;
  if (fromEnv) return fromEnv.trim();
  throw new Error(
    'no GM key: set GM_NSEC or pass --key <file>. The key is never read from the config file.',
  );
}

async function loadModules(specifiers: string[]): Promise<AnyGameModule[]> {
  const modules: AnyGameModule[] = [];
  for (const specifier of specifiers) {
    const imported = (await import(specifier)) as Record<string, unknown>;
    // Accept a default export or any named export that looks like a module,
    // so a package need not adopt a convention just to be hostable.
    const candidates = [imported.default, ...Object.values(imported)];
    const found = candidates.find(
      (value): value is AnyGameModule =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as AnyGameModule).id === 'string' &&
        typeof (value as AnyGameModule).apply === 'function',
    );
    if (!found) throw new Error(`${specifier} does not export a GameModule`);
    modules.push(found);
  }
  return modules;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const config = JSON.parse(await readFile(args.config, 'utf8')) as GMConfig;
  const secret = await loadSecretKey(args.key);
  const modules = await loadModules(config.modules);

  // Non-literal specifier: resolved by the runtime, never linked at build time.
  const specifier = config.adapter ?? 'nip-gm-nostr';
  const loaded = (await import(specifier).catch(() => undefined)) as Partial<TransportAdapter> | undefined;

  if (!loaded?.createTransport || !loaded.createKeySigner) {
    throw new Error(
      `${specifier} does not export createTransport and createKeySigner. ` +
        'Until a relay adapter ships (milestone 6), call createGM() directly with your own Transport and KeySigner.',
    );
  }

  const gm = createGM({
    modules,
    signer: loaded.createKeySigner(secret),
    transport: loaded.createTransport({ relays: config.relays }),
    relays: config.relays,
    policy: config.policy,
    lobbyDefaults: config.lobbyDefaults,
  });

  await gm.start();
  console.log(`[nip-gm] running as ${gm.pubkey} with ${modules.length} module(s)`);

  const shutdown = (): void => void gm.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only auto-run when invoked as a binary, so the module stays importable in tests.
if (process.argv[1]?.endsWith('gm.js')) {
  main().catch((error: unknown) => {
    console.error(`[nip-gm] ${(error as Error).message}`);
    process.exit(1);
  });
}
