/**
 * Reading a message body that may or may not have been encrypted to us.
 *
 * NIP-GM encrypts the `create` and `join` bodies to the GM because they may
 * carry a join code (§Game Messages). Nothing on the wire distinguishes a
 * NIP-44 payload from a plaintext one, though — both are just `content` — so
 * the GM has to decide what to do with a body it cannot decrypt.
 *
 * It falls back to reading it as plaintext, for two reasons. Clients predating
 * encryption keep working, which matters because a GM is a public service and
 * cannot upgrade its callers. And nothing is lost by allowing it: a code sent in
 * the clear was already exposed on the relay by the client that sent it, and no
 * fallback here helps someone who does not know a code guess one. What the GM
 * must never do is the opposite — accept a *wrong* code — and that decision
 * lives in the lobby manager, where it can only be made against the plaintext.
 */
import type { Hex } from 'nip-gm-core';

export type Decrypt = (peer: Hex, ciphertext: string) => Promise<string>;

export async function readSecretBody(
  decrypt: Decrypt,
  peer: Hex,
  content: string,
): Promise<string> {
  // An empty body is every ungated join, and decrypting it would only throw.
  if (content.trim() === '') return content;

  try {
    return await decrypt(peer, content);
  } catch {
    return content;
  }
}
