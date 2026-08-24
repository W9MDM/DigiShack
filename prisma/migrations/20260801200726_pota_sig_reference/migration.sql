-- AlterTable
ALTER TABLE `Qso` ADD COLUMN `sig` VARCHAR(32) NULL,
    ADD COLUMN `sigInfo` VARCHAR(32) NULL;

-- CreateIndex
CREATE INDEX `Qso_sigInfo_idx` ON `Qso`(`sigInfo`);
