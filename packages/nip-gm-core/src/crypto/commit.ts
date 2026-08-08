/**
 * Seed commit and reveal.
 *
 * NIP-GM §Hidden Information: before the game starts the GM samples a seed and
 * publishes `seed_commit = sha256(seed || salt)`. Every shuffle and roll derives
 * deterministically from that seed; at game end the seed and salt are revealed
 * so auditors recompute the commit and re-derive every draw.
 *
 * This is what stops a GM picking outcomes after seeing play. It does not stop a
 * GM *knowing* the deck and leaking it to a colluder — inherent to any
 * trusted-dealer design, and explicitly out of scope.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from '@noble/hashes/utils';
import type { Hex } from '../types.js';

export interface SeedCommitment {
  seed: Uint8Array;
  salt: Uint8Array;
  /** Hex sha256(seed || salt) — goes in the start event. */
  commit: string;
}

/** `sha256(seed || salt)`, hex. */
export function seedCommit(seed: Uint8Array, salt: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(seed, salt)));
}

/**
 * Sample a fresh seed and salt and compute the commitment.
 *
 * The salt exists because a seed alone is guessable in principle if a module's
 * seed space is ever small; salting means the commitment reveals nothing even
 * then.
 */
export function createSeedCommitment(): SeedCommitment {
  const seed = randomBytes(32);
  const salt = randomBytes(32);
  return { seed, salt, commit: seedCommit(seed, salt) };
}

/** Constant-time-ish string compare on the hex commitment. */
export function verifySeedCommit(commit: string, seed: Uint8Array, salt: Uint8Array): boolean {
  const actual = seedCommit(seed, salt);
  if (actual.length !== commit.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ commit.charCodeAt(i);
  return diff === 0;
}

/**
 * Combine the GM seed with optional player seed contributions.
 *
 * NIP-GM §Player seed contributions: modules wanting randomness no single party
 * controls can require each player to commit a seed and reveal it at the end;
 * the effective seed is a hash over all contributions.
 *
 * Contributions are folded in **ascending pubkey order**, not in the order they
 * arrived, so that the GM and every auditor derive the same value regardless of
 * relay delivery order.
 *
 * Tradeoff worth knowing before requiring this: a player who leaves without
 * revealing renders the game partially unverifiable, so modules should ask for
 * it only where it matters.
 */
export function combineSeeds(gmSeed: Uint8Array, playerSeeds: Record<Hex, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [gmSeed];
  for (const pubkey of Object.keys(playerSeeds).sort()) {
    parts.push(hexToBytes(pubkey), playerSeeds[pubkey]);
  }
  return sha256(concatBytes(...parts));
}
