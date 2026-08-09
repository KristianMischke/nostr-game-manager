/**
 * Who may ask this GM to do what.
 *
 * Kept separate from the lobby manager because it is the one part of the daemon
 * an operator is expected to care about: running a public GM with
 * `allowCreate: 'anyone'` and no `maxConcurrentGames` is an open invitation to
 * fill its memory. The defaults here are deliberately the cautious ones.
 */
import type { Hex } from 'nip-gm-core';

export interface GMPolicy {
  /** Who may ask this GM to open a lobby (NIP-GM §Game Messages — GM policy). */
  allowCreate: 'anyone' | 'allowlist' | 'nobody';
  allowlist?: Hex[];
  /** Omit for unlimited. */
  maxConcurrentGames?: number;
}

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

export function mayCreate(policy: GMPolicy, requester: Hex, activeGames: number): PolicyDecision {
  if (policy.allowCreate === 'nobody') return { ok: false, reason: 'lobby_creation_disabled' };
  if (policy.allowCreate === 'allowlist' && !policy.allowlist?.includes(requester)) {
    return { ok: false, reason: 'not_allowed' };
  }
  if (policy.maxConcurrentGames !== undefined && activeGames >= policy.maxConcurrentGames) {
    return { ok: false, reason: 'gm_at_capacity' };
  }
  return { ok: true };
}
