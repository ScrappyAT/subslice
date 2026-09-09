/**
 * Flutterwave API v3, pinned — a constant in config, not an environment
 * variable. Per AGENTS.md: this project talks to exactly one version,
 * deliberately (v4's charge flow risks a card number reaching this server),
 * and a config constant can't be silently repointed by an edited .env the
 * way a base-URL env var could.
 */
export const FLW_BASE_URL = "https://api.flutterwave.com/v3";

/**
 * Never logged, never returned to a client — every call site that needs
 * this reads it here rather than touching process.env directly, so there
 * is exactly one place that ever holds the raw value in a variable.
 */
export function getFlutterwaveSecretKey(): string {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) {
    throw new Error("FLW_SECRET_KEY is not set");
  }
  return key;
}
