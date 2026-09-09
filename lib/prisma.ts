import { PrismaClient } from "@prisma/client";

// Next.js dev mode hot-reloads modules on every file save, but does not
// reset the Node.js process. Without this, each reload would re-run this
// module top to bottom and construct a brand new PrismaClient, and each
// PrismaClient opens its own connection pool — so a few edits in development
// would exhaust Postgres's connection limit. Stashing the instance on
// `globalThis` survives the module reload, so the same client (and the same
// pool) is reused across saves. In production there is no hot reload, so a
// single instance is created once and this is a no-op.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
