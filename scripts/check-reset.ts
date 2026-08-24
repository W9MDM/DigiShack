// Assertions on the password-reset token lifecycle, against the real database.
//
// Uses a throwaway user so nothing here can touch a real account, and cleans up
// after itself even on failure. What is asserted is the lifecycle — issue,
// redeem, replay, expire, revoke-on-reissue — because every one of those is a
// security property, not a convenience.

import { randomBytes } from "node:crypto";

import { verifyPassword } from "@/lib/auth/password";
import { consumePasswordReset, createPasswordReset } from "@/lib/auth/reset";
import { prisma } from "@/lib/db/prisma";

let failed = 0;
function ok(cond: boolean, what: string): void {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok   " : "FAIL "} ${what}`);
}

async function main() {
  const email = `check-reset-${randomBytes(6).toString("hex")}@example.invalid`;
  const user = await prisma.user.create({
    data: { email, name: "check-reset fixture", passwordHash: "scrypt$x$x$x$x$x" },
  });

  try {
    console.log("issue and redeem");
    const token = await createPasswordReset(user.id);
    ok(token.length >= 40, "the raw token is long enough to be a credential");
    const stored = await prisma.passwordReset.findFirst({ where: { userId: user.id } });
    ok(stored !== null && !token.includes(stored.tokenHash), "only the hash is stored");

    const good = await consumePasswordReset(token, "a-brand-new-password");
    ok(good.ok, "a valid token redeems");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    ok(
      await verifyPassword("a-brand-new-password", fresh.passwordHash),
      "and the new password verifies",
    );

    console.log("\nreplay and forgery");
    const replay = await consumePasswordReset(token, "second-try-password");
    ok(!replay.ok, "the same token refuses a second use");
    const forged = await consumePasswordReset(randomBytes(32).toString("base64url"), "x".repeat(16));
    ok(!forged.ok, "an invented token refuses");

    console.log("\nexpiry and reissue");
    const expired = await createPasswordReset(user.id);
    await prisma.passwordReset.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    ok(!(await consumePasswordReset(expired, "x".repeat(16))).ok, "an expired token refuses");

    const first = await createPasswordReset(user.id);
    const second = await createPasswordReset(user.id);
    ok(!(await consumePasswordReset(first, "x".repeat(16))).ok, "reissue revokes the older token");
    ok((await consumePasswordReset(second, "x".repeat(16))).ok, "and the newest one works");

    console.log("\ndisabled accounts");
    const third = await createPasswordReset(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    ok(
      !(await consumePasswordReset(third, "x".repeat(16))).ok,
      "a disabled account cannot redeem — disabling means locked out, all doors",
    );
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }

  console.log(failed === 0 ? "\nall reset assertions passed" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
