import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Pages Router. Deliberate: the DigiShack spec targets Pages Router to match
  // the other self-hosted projects (Sidetone, Squelch, inode, HamHub). There is
  // no `app/` directory — do not add one.

  // Prisma must not be bundled into the serverless/edge trace; it needs its
  // generated native query engine at runtime.
  serverExternalPackages: ["@prisma/client", "prisma", "bullmq", "ioredis"],

  // The backup route walks data/ and backups/ at runtime. The bundler reads a
  // directory walk under process.cwd() as a possible dynamic import and pulls the
  // whole project into the deployment trace — including a 14 MB QSL card image.
  // These are runtime data paths, never modules.
  outputFileTracingExcludes: {
    "/api/backup": ["./data/**", "./backups/**", "./.next/**", "./node_modules/**"],
  },
};

export default nextConfig;
