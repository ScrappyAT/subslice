import { PrismaClient } from "@prisma/client";

// Standard Next.js/Prisma singleton: in dev, module reloads on every request
// would otherwise open a fresh connection pool each time. Cached on
// globalThis so hot-reload reuses the same client.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
