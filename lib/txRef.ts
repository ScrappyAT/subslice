import { randomBytes } from "crypto";

/**
 * Unique per attempt (128 bits of randomness — a collision is not a
 * practical concern), unguessable (a guessable tx_ref would let one request
 * probe for another user's in-flight checkout), and traceable back to the
 * user and plan only through the PaymentEvent row it's stored on, never by
 * decoding the string itself. Shared by the plain checkout route and the
 * upgrade quote step so a tx_ref is generated exactly one way.
 */
export function generateTxRef(): string {
  return `chk_${randomBytes(16).toString("hex")}`;
}
