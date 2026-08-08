import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Package dependency DAG. A package may import only from the packages listed
 * for it (plus itself). Enforced below via no-restricted-imports.
 *
 *   core ──┬── client ──── react
 *          ├── gm
 *          ├── nostr
 *          └── testing
 *
 * `core` is the port target for future C#/Rust/Python implementations, so it
 * must never reach for a nostr library, a network, or a UI framework.
 */
const ALL = [
  'nip-gm-core',
  'nip-gm-client',
  'nip-gm-gm',
  'nip-gm-nostr',
  'nip-gm-react',
  'nip-gm-testing',
];

const ALLOWED = {
  'nip-gm-core': [],
  'nip-gm-client': ['nip-gm-core'],
  'nip-gm-gm': ['nip-gm-core'],
  'nip-gm-nostr': ['nip-gm-core'],
  'nip-gm-react': ['nip-gm-core', 'nip-gm-client'],
  'nip-gm-testing': ['nip-gm-core', 'nip-gm-client', 'nip-gm-gm'],
};

/** Extra import bans beyond the workspace DAG. */
const EXTRA_BANS = {
  // The whole point of core is that it ports mechanically to other languages.
  'nip-gm-core': [
    { group: ['@nostr-dev-kit/*', 'nostr-tools', 'nostr-tools/*'], message: 'nip-gm-core must stay free of nostr libraries — it defines its own structural event types. Use nip-gm-nostr for bindings.' },
    { group: ['react', 'react/*', 'solid-js', 'solid-js/*'], message: 'nip-gm-core must stay framework-free.' },
    { group: ['node:*'], message: 'nip-gm-core must stay runtime-agnostic (no node builtins).' },
  ],
  'nip-gm-client': [
    { group: ['@nostr-dev-kit/*', 'nostr-tools', 'nostr-tools/*'], message: 'nip-gm-client talks to relays only through the Transport port from nip-gm-core.' },
    { group: ['react', 'react/*', 'solid-js', 'solid-js/*'], message: 'nip-gm-client must stay framework-free — that is what makes the react and solid bindings thin.' },
  ],
  'nip-gm-gm': [
    { group: ['react', 'react/*', 'solid-js', 'solid-js/*'], message: 'The GM daemon must not depend on a UI framework.' },
  ],
};

const dagConfigs = ALL.map((pkg) => ({
  files: [`packages/${pkg}/src/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          ...ALL.filter((p) => p !== pkg && !ALLOWED[pkg].includes(p)).map((p) => ({
            group: [p, `${p}/*`],
            message: `${pkg} may not import ${p}. Allowed: ${ALLOWED[pkg].join(', ') || 'none'}. See the DAG in eslint.config.js.`,
          })),
          ...(EXTRA_BANS[pkg] ?? []),
        ],
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  ...dagConfigs,
  {
    // Hook rules apply only to the React binding; nothing else in the workspace
    // is allowed to know React exists.
    files: ['packages/nip-gm-react/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'packages/nip-gm-testing/src/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
