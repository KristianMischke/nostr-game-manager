/**
 * Per-round ephemeral keys for hidden moves.
 *
 * NIP-GM §Hidden Information: a player generates an ephemeral keypair, puts its
 * pubkey in the move event as `["ephemeral", "<pubkey>"]`, and NIP-44-encrypts
 * the move to the GM using it. The signed, timestamped, persistent ciphertext is
 * the commitment; revealing the conversation key makes it verifiable.
 *
 * The GM derives that key itself — `ECDH(gm_priv, ephemeral_pub)` equals what
 * the player computed — so reveals never need player cooperation and no private
 * key is ever transmitted.
 */
import type { Hex } from '../types.js';
import { generateSecretKey, getPublicKey } from './event.js';
import { conversationKey } from './nip44.js';

export interface EphemeralKeypair {
  privkey: Uint8Array;
  pubkey: Hex;
}

/**
 * A fresh ephemeral keypair.
 *
 * **Generate a new one per round** when using the per-round reveal cadence,
 * which NIP-GM requires for simultaneous rounds. A conversation key decrypts
 * *everything* exchanged between one pair of keys, so reusing an ephemeral key
 * across rounds means the reveal that opens this round retroactively opens every
 * earlier one. One key per game is correct only for the end-of-game cadence,
 * where nothing is revealed until play is over.
 */
export function generateEphemeralKeypair(): EphemeralKeypair {
  const privkey = generateSecretKey();
  return { privkey, pubkey: getPublicKey(privkey) };
}

/** Player side: the key to encrypt this round's move to the GM. */
export function playerConversationKey(ephemeral: EphemeralKeypair, gmPubkey: Hex): Uint8Array {
  return conversationKey(ephemeral.privkey, gmPubkey);
}

/**
 * GM side: the same key, derived from the ephemeral pubkey in the move event.
 *
 * This is the value published in a round-closing delta's `key` field, or in the
 * end event's `key_reveals`.
 */
export function gmConversationKey(gmPrivkey: Uint8Array, ephemeralPubkey: Hex): Uint8Array {
  return conversationKey(gmPrivkey, ephemeralPubkey);
}
