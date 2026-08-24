-- AlterTable
ALTER TABLE `Qso` ADD COLUMN `clublogSent` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `hrdlogSent` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `qrzSent` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `Qso_qrzSent_idx` ON `Qso`(`qrzSent`);

-- CreateIndex
CREATE INDEX `Qso_clublogSent_idx` ON `Qso`(`clublogSent`);

-- CreateIndex
CREATE INDEX `Qso_hrdlogSent_idx` ON `Qso`(`hrdlogSent`);

-- CreateIndex
CREATE INDEX `Qso_eqslSent_idx` ON `Qso`(`eqslSent`);
