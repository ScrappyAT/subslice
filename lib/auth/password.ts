import bcrypt from "bcrypt";

// bcrypt's cost is a power-of-two work factor: each +1 doubles the time to
// hash and to verify. 12 is chosen as the floor OWASP currently recommends
// for bcrypt — slow enough that brute-forcing a stolen hash offline is
// expensive (measured on this machine: see DOCUMENTATION.md), but fast
// enough that one honest login is imperceptible. Going lower (e.g. 4) makes
// verification near-instant, which helps an attacker far more than it helps
// a real user, since the real user only ever pays this cost once per login
// while an attacker pays it millions of times over a stolen hash. Going
// much higher slows every real login and signup for a benefit that mostly
// matters to attackers with far more compute than the honest user has to
// wait through.
export const BCRYPT_COST_FACTOR = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST_FACTOR);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
