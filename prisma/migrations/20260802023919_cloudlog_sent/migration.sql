-- AlterTable
ALTER TABLE `Qso` ADD COLUMN `cloudlogSent` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `Qso_cloudlogSent_idx` ON `Qso`(`cloudlogSent`);
