-- Reception reports that belong to no contact.
--
-- Most reports of an FT8 station are of its CQs, and a CQ nobody answered produced no
-- contact to attach them to. They were counted and discarded: 193 of 368 on the first
-- real query, which is the majority of the evidence about who can hear this station
-- thrown away for want of somewhere to put it.
ALTER TABLE `PskSpot` DROP FOREIGN KEY `PskSpot_qsoId_fkey`;
ALTER TABLE `PskSpot` MODIFY `qsoId` VARCHAR(191) NULL;

-- The dedupe key led with qsoId, and MySQL treats NULLs in a unique index as distinct —
-- so leaving it that way would have stopped deduping exactly the rows that now have no
-- contact, and PSKReporter's polling windows overlap on purpose. Who heard us, when, and
-- on what frequency is the natural identity of a reception report; the contact it happens
-- to fall inside is not part of it.
--
-- Named as the database has it, not as Prisma's @@unique(name:) reads: that argument names
-- the compound key in the generated client, and the index itself is named after its
-- columns. Dropping the name from the model would rename it; this migration exists partly
-- to record that they are two different names.
DROP INDEX `PskSpot_qsoId_receiverCall_reportedAt_freqHz_key` ON `PskSpot`;
CREATE UNIQUE INDEX `PskSpot_receiverCall_reportedAt_freqHz_key`
  ON `PskSpot`(`receiverCall`, `reportedAt`, `freqHz`);
CREATE INDEX `PskSpot_qsoId_idx` ON `PskSpot`(`qsoId`);

-- Recreated as SET NULL rather than CASCADE: a deleted contact must not take the evidence
-- that somebody heard the transmission with it.
ALTER TABLE `PskSpot` ADD CONSTRAINT `PskSpot_qsoId_fkey`
  FOREIGN KEY (`qsoId`) REFERENCES `Qso`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
