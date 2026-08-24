-- AlterTable
ALTER TABLE `Qso` ADD COLUMN `continent` VARCHAR(4) NULL,
    ADD COLUMN `county` VARCHAR(64) NULL,
    ADD COLUMN `cqZone` INTEGER NULL,
    ADD COLUMN `iota` VARCHAR(16) NULL,
    ADD COLUMN `ituZone` INTEGER NULL,
    ADD COLUMN `state` VARCHAR(16) NULL;

-- CreateIndex
CREATE INDEX `Qso_state_idx` ON `Qso`(`state`);

-- CreateIndex
CREATE INDEX `Qso_cqZone_idx` ON `Qso`(`cqZone`);

-- CreateIndex
CREATE INDEX `Qso_iota_idx` ON `Qso`(`iota`);

-- CreateIndex
CREATE INDEX `Qso_continent_idx` ON `Qso`(`continent`);
