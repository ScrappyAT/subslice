import { z } from "zod";

// The single source of validation truth. Every API route parses request
// bodies with these schemas; every form imports the same objects for
// inline client-side feedback. Nothing else in the codebase should
// hand-roll a validation rule.

// Normalised once, here, so every schema that takes an email applies the
// same transform before the value can reach the database's unique
// constraint on User.email. Order matters: trim and lowercase run as
// transforms first, then `.email()` checks the *normalised* value, so
// " Test@Example.com " both normalises and validates correctly.
const email = z.string().trim().toLowerCase().email();

// bcrypt only hashes the first 72 bytes of its input; anything past that
// is silently ignored. Rather than let a user believe an 80-character
// password protects them when only the first 72 bytes do, the max here
// makes that boundary an explicit, visible validation error instead of a
// silent truncation.
const newPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters");

export const signupSchema = z.object({
  email,
  password: newPassword,
  name: z.string().trim().min(1, "Name is required").max(100, "Name must be at most 100 characters"),
});

export const signinSchema = z.object({
  email,
  // Deliberately not the same rule as newPassword: this is checked against
  // an existing bcrypt hash, not used to set one. A min/max complexity
  // rule here would only ever reject the correct password for an account
  // whose password predates a policy change; the length cap is kept only
  // to stop a pathologically large payload from being handed to
  // bcrypt.compare().
  password: z.string().min(1, "Password is required").max(72, "Password must be at most 72 characters"),
});

export const resetRequestSchema = z.object({
  email,
});

export const resetPasswordSchema = z.object({
  // The token is the raw 32 random bytes from the emailed link. Its shape
  // is an implementation detail of lib/auth/tokens.ts (not built yet), so
  // this only requires non-empty rather than pinning an exact length or
  // encoding the token schema would then have to stay in lockstep with.
  token: z.string().min(1, "Reset token is required"),
  password: newPassword,
});

export const verifyCodeSchema = z.object({
  // No session exists yet at this point in the flow (session creation is
  // step 6, after verification), so the email is what identifies which
  // user's code is being checked.
  email,
  code: z.string().length(6, "Code must be 6 digits").regex(/^\d{6}$/, "Code must be 6 digits"),
});

export const resendCodeSchema = z.object({
  email,
});

export const checkoutSchema = z.object({
  // This only checks shape. Whether the code names a real, chargeable plan
  // is a database question, answered against the Plan table in the route —
  // not something a schema encoding a hardcoded list of plan codes could
  // answer without becoming a second source of truth for what plans exist.
  planCode: z.string().min(1, "Plan code is required"),
});

export const downgradeSchema = z.object({
  // Same reasoning as checkoutSchema: shape only. Whether it names a real,
  // active, cheaper plan is answered against the Plan table in
  // lib/downgrade.ts, not duplicated here as a second source of truth.
  targetPlanCode: z.string().min(1, "Target plan code is required"),
});

export const confirmUpgradeSchema = z.object({
  // The tx_ref from an earlier quote, and nothing else — there is no
  // amount field here at all. zod strips unknown keys by default, so a
  // client-submitted charge amount is not merely distrusted, it is never
  // even parsed into the value the route goes on to use.
  txRef: z.string().min(1, "txRef is required"),
});

export const cancellationReasonSchema = z.object({
  // Free text from a user, and it ends up in a database column
  // (PaymentEvent.reason, a plain TEXT column with no built-in limit) —
  // this cap is the only one that exists. 500 characters is generous for
  // "why are you leaving" feedback without inviting unbounded storage.
  reason: z.string().trim().min(1, "Reason is required").max(500, "Reason must be at most 500 characters"),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type SigninInput = z.infer<typeof signinSchema>;
export type ResetRequestInput = z.infer<typeof resetRequestSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type VerifyCodeInput = z.infer<typeof verifyCodeSchema>;
export type ResendCodeInput = z.infer<typeof resendCodeSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type DowngradeInput = z.infer<typeof downgradeSchema>;
export type ConfirmUpgradeInput = z.infer<typeof confirmUpgradeSchema>;
export type CancellationReasonInput = z.infer<typeof cancellationReasonSchema>;
