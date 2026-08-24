-- AlterTable
ALTER TABLE `Qso` ADD COLUMN `emailQslSent` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `emailQslSentAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Qso_emailQslSent_idx` ON `Qso`(`emailQslSent`);
