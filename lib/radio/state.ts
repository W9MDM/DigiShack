import { prisma } from "@/lib/db/prisma";

// The bridge's own runtime state - auto mode and when the run started, the schedule's applied
// answer, the last no-power restart - written straight to the table, not through
// writeSettings(): there is no user to audit, and these keys are state, not configuration.
//
// ONE PLACE FOR IT, because this state belongs to a RADIO. Today an install has one, so this
// writes the same Setting row the bridge always wrote. When an install runs several radios
// each will keep its own, and a write that bypassed this function would let one radio's
// "auto mode was CQ" resume automation on another. check:radio-state-writes refuses any
// direct prisma.setting write under services/radio.
export async function writeRadioState(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value, encrypted: false },
    update: { value },
  });
}
