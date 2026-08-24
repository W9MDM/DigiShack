import { PrismaClient } from "@prisma/client";

// Single client per process. Next.js dev-mode hot reload re-evaluates modules,
// so without the globalThis cache each reload leaks a connection pool until
// MySQL refuses new connections.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
