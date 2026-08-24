// Break-glass password reset, from a shell on the server.
//
//   npm run reset-password -- someone@example.com
//   npm run reset-password -- someone@example.com "TheNewPassword!"
//
// This exists for the lockout the UI cannot fix: no working SMTP, no other admin,
// nobody who can log in. Anyone who can run it already owns the database, so it
// grants nothing they lack — it just replaces "edit passwordHash by hand with a
// scrypt you computed somewhere" with one honest command. With no password argument
// it generates one and prints it; change it from the Account page after logging in.
//
// Every session for the user is revoked, same as every other reset path.

import { randomBytes } from "node:crypto";

import { hashPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { destroyAllSessions } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

async function main() {
  const [email, given] = process.argv.slice(2);
  if (!email || !email.includes("@")) {
    console.error("Usage: npm run reset-password -- <email> [new-password]");
    process.exit(2);
  }
  if (given !== undefined && given.length < MIN_PASSWORD_LENGTH) {
    console.error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(2);
  }

  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, email: true, callsign: true, active: true },
  });
  if (!user) {
    // A CLI in the operator's own shell has no enumeration concern — being
    // specific here is pure help.
    console.error(`No account with the address ${email}.`);
    process.exit(1);
  }

  const password = given ?? randomBytes(18).toString("base64url").slice(0, 16);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(password) },
  });
  const revoked = await destroyAllSessions(user.id);

  console.log(`Password reset for ${user.email}${user.callsign ? ` (${user.callsign})` : ""}.`);
  console.log(`Revoked ${revoked} session(s).`);
  if (!user.active) console.log("NOTE: the account is DISABLED — enable it from the Users page.");
  if (given === undefined) {
    console.log(`\nGenerated password: ${password}`);
    console.log("Change it from the Account page after signing in.");
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
