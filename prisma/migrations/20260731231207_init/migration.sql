-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `callsign` VARCHAR(32) NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `role` ENUM('ADMIN', 'OPERATOR', 'VIEWER') NOT NULL DEFAULT 'VIEWER',
    `active` BOOLEAN NOT NULL DEFAULT true,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `userAgent` VARCHAR(255) NULL,
    `ip` VARCHAR(64) NULL,

    UNIQUE INDEX `Session_tokenHash_key`(`tokenHash`),
    INDEX `Session_userId_idx`(`userId`),
    INDEX `Session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Setting` (
    `key` VARCHAR(64) NOT NULL,
    `value` TEXT NOT NULL,
    `encrypted` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(32) NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Station` (
    `id` VARCHAR(191) NOT NULL,
    `callsign` VARCHAR(32) NOT NULL,
    `grid` VARCHAR(12) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Station_callsign_idx`(`callsign`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Operator` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `callsign` VARCHAR(32) NOT NULL,
    `stationId` VARCHAR(191) NOT NULL,
    `role` ENUM('ADMIN', 'OPERATOR', 'VIEWER') NOT NULL DEFAULT 'OPERATOR',
    `userId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Operator_callsign_idx`(`callsign`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Rig` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` ENUM('FLEX_6000', 'FLEX_8000', 'HAMLIB_NET', 'MANUAL') NOT NULL,
    `ipAddress` VARCHAR(64) NULL,
    `stationId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Qso` (
    `id` VARCHAR(191) NOT NULL,
    `callsign` VARCHAR(32) NOT NULL,
    `band` VARCHAR(12) NOT NULL,
    `freqHz` BIGINT NOT NULL,
    `mode` VARCHAR(12) NOT NULL,
    `startTime` DATETIME(3) NOT NULL,
    `endTime` DATETIME(3) NULL,
    `rstSent` VARCHAR(12) NULL,
    `rstRcvd` VARCHAR(12) NULL,
    `gridSquare` VARCHAR(12) NULL,
    `dxcc` INTEGER NULL,
    `qslSent` ENUM('NONE', 'REQUESTED', 'SENT', 'CONFIRMED') NOT NULL DEFAULT 'NONE',
    `qslRcvd` ENUM('NONE', 'REQUESTED', 'SENT', 'CONFIRMED') NOT NULL DEFAULT 'NONE',
    `qslSentAt` DATETIME(3) NULL,
    `qslRcvdAt` DATETIME(3) NULL,
    `lotwSent` BOOLEAN NOT NULL DEFAULT false,
    `lotwRcvd` BOOLEAN NOT NULL DEFAULT false,
    `eqslSent` BOOLEAN NOT NULL DEFAULT false,
    `eqslRcvd` BOOLEAN NOT NULL DEFAULT false,
    `notes` TEXT NULL,
    `stationId` VARCHAR(191) NOT NULL,
    `operatorId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Qso_callsign_idx`(`callsign`),
    INDEX `Qso_startTime_idx`(`startTime`),
    INDEX `Qso_band_mode_idx`(`band`, `mode`),
    INDEX `Qso_callsign_band_mode_idx`(`callsign`, `band`, `mode`),
    INDEX `Qso_gridSquare_idx`(`gridSquare`),
    INDEX `Qso_dxcc_idx`(`dxcc`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DigitalDecode` (
    `id` VARCHAR(191) NOT NULL,
    `timestamp` DATETIME(3) NOT NULL,
    `freqOffset` INTEGER NOT NULL,
    `snr` INTEGER NOT NULL,
    `message` VARCHAR(128) NOT NULL,
    `mode` VARCHAR(12) NOT NULL,
    `band` VARCHAR(12) NOT NULL,
    `qsoId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DigitalDecode_timestamp_idx`(`timestamp`),
    INDEX `DigitalDecode_band_mode_idx`(`band`, `mode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PskSpot` (
    `id` VARCHAR(191) NOT NULL,
    `qsoId` VARCHAR(191) NOT NULL,
    `receiverCall` VARCHAR(32) NOT NULL,
    `receiverGrid` VARCHAR(12) NULL,
    `snr` INTEGER NULL,
    `freqHz` BIGINT NOT NULL,
    `reportedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PskSpot_reportedAt_idx`(`reportedAt`),
    UNIQUE INDEX `PskSpot_qsoId_receiverCall_reportedAt_freqHz_key`(`qsoId`, `receiverCall`, `reportedAt`, `freqHz`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Operator` ADD CONSTRAINT `Operator_stationId_fkey` FOREIGN KEY (`stationId`) REFERENCES `Station`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Operator` ADD CONSTRAINT `Operator_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Rig` ADD CONSTRAINT `Rig_stationId_fkey` FOREIGN KEY (`stationId`) REFERENCES `Station`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Qso` ADD CONSTRAINT `Qso_stationId_fkey` FOREIGN KEY (`stationId`) REFERENCES `Station`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Qso` ADD CONSTRAINT `Qso_operatorId_fkey` FOREIGN KEY (`operatorId`) REFERENCES `Operator`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DigitalDecode` ADD CONSTRAINT `DigitalDecode_qsoId_fkey` FOREIGN KEY (`qsoId`) REFERENCES `Qso`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PskSpot` ADD CONSTRAINT `PskSpot_qsoId_fkey` FOREIGN KEY (`qsoId`) REFERENCES `Qso`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
