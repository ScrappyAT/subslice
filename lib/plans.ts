import type { Plan as PrismaPlan } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * A typed accessor over the seeded Plan rows — deliberately not a set of
 * constants re-declaring the prices. The migration seeds `free`, `monthly`
 * and `yearly` once; this reads them back. Redeclaring the prices here as
 * well would give the app two sources of truth for a plan's price, which is
 * exactly the bug "Events carry their own facts" (AGENTS.md) exists to
 * guard against on the log side — this is the read side of the same
 * principle.
 */
export type PlanCode = "free" | "monthly" | "yearly";

export interface PlanConfig {
  code: PlanCode;
  name: string;
  amountMinor: number;
  currency: string;
  interval: "NONE" | "MONTH" | "YEAR";
  active: boolean;
}

function toPlanConfig(plan: PrismaPlan): PlanConfig {
  return {
    code: plan.code as PlanCode,
    name: plan.name,
    amountMinor: plan.amountMinor,
    // Postgres CHAR(3) pads short values with trailing spaces on read;
    // every currency this app stores is exactly 3 characters, so this
    // never actually strips anything — it's a defensive no-op, not a fix
    // for a real case.
    currency: plan.currency.trim(),
    interval: plan.interval,
    active: plan.active,
  };
}

/** A single plan by code. Throws if the code doesn't exist — every plan
 * code this app ever passes here is either a literal or a foreign-key-
 * checked column value, so a miss means a real bug, not a case to handle. */
export async function getPlan(code: PlanCode): Promise<PlanConfig> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code } });
  return toPlanConfig(plan);
}

/** The plans a plans view or checkout screen should offer, cheapest first. */
export async function listActivePlans(): Promise<PlanConfig[]> {
  const plans = await prisma.plan.findMany({
    where: { active: true },
    orderBy: { amountMinor: "asc" },
  });
  return plans.map(toPlanConfig);
}
