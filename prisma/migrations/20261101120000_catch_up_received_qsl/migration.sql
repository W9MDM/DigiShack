-- Catch-up: the received-QSL schema from 1.264-1.266 shipped with no migration. Installs
-- that updated by `prisma db push` already have it; a fresh install built from migrations
-- did not, and every /api/v1/qsos call failed on the missing Qso.emailQslRcvd column.
--
-- Every statement is guarded, so this runs cleanly on both. MySQL has no
-- ADD COLUMN IF NOT EXISTS, hence the information_schema checks and prepared statements.

SET @db = DATABASE();

SET @s = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'Qso' AND COLUMN_NAME = 'emailQslRcvd') = 0,
  'ALTER TABLE `Qso` ADD COLUMN `emailQslRcvd` BOOLEAN NOT NULL DEFAULT false', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'Qso' AND COLUMN_NAME = 'emailQslRcvdAt') = 0,
  'ALTER TABLE `Qso` ADD COLUMN `emailQslRcvdAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'Qso' AND COLUMN_NAME = 'emailReplyRcvd') = 0,
  'ALTER TABLE `Qso` ADD COLUMN `emailReplyRcvd` BOOLEAN NOT NULL DEFAULT false', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'Qso' AND COLUMN_NAME = 'emailReplyRcvdAt') = 0,
  'ALTER TABLE `Qso` ADD COLUMN `emailReplyRcvdAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS `ReceivedQsl` (
    `id` VARCHAR(32) NOT NULL,
    `qsoId` VARCHAR(191) NULL,
    `callsign` VARCHAR(32) NOT NULL,
    `kind` ENUM('CARD', 'REPLY', 'NOTICE', 'BOUNCE') NOT NULL,
    `sender` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `messageId` VARCHAR(191) NOT NULL,
    `attachmentKey` VARCHAR(64) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL,
    `imagePath` VARCHAR(191) NULL,
    `imageContentType` VARCHAR(32) NULL,
    `imageBytes` INTEGER NULL,
    `fileName` VARCHAR(255) NULL,
    `link` VARCHAR(1024) NULL,
    `matchStatus` ENUM('MATCHED', 'AMBIGUOUS', 'UNMATCHED', 'DISMISSED') NOT NULL,
    `matchNote` TEXT NULL,
    `filedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `ReceivedQsl_qsoId_idx`(`qsoId`),
    INDEX `ReceivedQsl_matchStatus_receivedAt_idx`(`matchStatus`, `receivedAt`),
    INDEX `ReceivedQsl_kind_receivedAt_idx`(`kind`, `receivedAt`),
    INDEX `ReceivedQsl_callsign_idx`(`callsign`),
    UNIQUE INDEX `ReceivedQsl_messageId_attachmentKey_key`(`messageId`, `attachmentKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @s = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'ReceivedQsl' AND CONSTRAINT_NAME = 'ReceivedQsl_qsoId_fkey') = 0,
  'ALTER TABLE `ReceivedQsl` ADD CONSTRAINT `ReceivedQsl_qsoId_fkey` FOREIGN KEY (`qsoId`) REFERENCES `Qso`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
