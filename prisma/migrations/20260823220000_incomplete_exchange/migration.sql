-- An exchange that swapped reports and was never acknowledged.
--
-- DigiShack logs a QSO when the far station's RR73 decodes. If it never does, the sequence goes
-- to `abandoned` and nothing survived but a DigitalDecode row with a null qsoId — so a contact
-- the other operator holds simply vanished from this side.
--
-- Found by reconciling QRZ card requests against the log: 13 requests for August 2026 had no
-- QSO here, and DigiShack's own decode history showed the far station coming back to us on
-- exactly those days. Same failure the operator had already hit under WSJT-X, reproduced by
-- this software.
--
-- NOT a QSO table. Nothing here uploads anywhere or counts for an award until a human promotes
-- it, because the pattern is genuinely ambiguous — "we sent the final roger and heard nothing"
-- fits both a contact they logged and one they gave up on too.
--
-- Written by hand and applied with `migrate deploy` — see the 20260805021500 note.
CREATE TABLE `IncompleteExchange` (
    `id` VARCHAR(191) NOT NULL,
    `callsign` VARCHAR(32) NOT NULL,
    `band` VARCHAR(12) NOT NULL,
    `mode` VARCHAR(12) NOT NULL,
    `freqHz` BIGINT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NOT NULL,
    `stage` VARCHAR(24) NOT NULL,
    `reportSent` VARCHAR(8) NULL,
    `reportRcvd` VARCHAR(8) NULL,
    `gridSquare` VARCHAR(12) NULL,
    `reason` VARCHAR(191) NOT NULL,
    `transcript` TEXT NULL,
    `stationId` VARCHAR(191) NOT NULL,
    `promotedQsoId` VARCHAR(191) NULL,
    `dismissedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `IncompleteExchange_callsign_idx`(`callsign`),
    INDEX `IncompleteExchange_startedAt_idx`(`startedAt`),
    INDEX `IncompleteExchange_promotedQsoId_idx`(`promotedQsoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CASCADE on the station: an exchange belongs to the station that made it.
-- SET NULL on the promoted QSO: deleting the contact must not delete the evidence it came from.
ALTER TABLE `IncompleteExchange` ADD CONSTRAINT `IncompleteExchange_stationId_fkey`
    FOREIGN KEY (`stationId`) REFERENCES `Station`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `IncompleteExchange` ADD CONSTRAINT `IncompleteExchange_promotedQsoId_fkey`
    FOREIGN KEY (`promotedQsoId`) REFERENCES `Qso`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
