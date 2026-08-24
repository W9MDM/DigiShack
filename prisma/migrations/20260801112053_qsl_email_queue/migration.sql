-- CreateTable
CREATE TABLE `QslEmail` (
    `id` VARCHAR(191) NOT NULL,
    `qsoId` VARCHAR(191) NOT NULL,
    `toAddress` VARCHAR(191) NOT NULL,
    `callsign` VARCHAR(32) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `bodyText` TEXT NOT NULL,
    `bodyHtml` TEXT NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'SENT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `error` TEXT NULL,
    `approvedById` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `QslEmail_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `QslEmail_qsoId_key`(`qsoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `QslEmail` ADD CONSTRAINT `QslEmail_qsoId_fkey` FOREIGN KEY (`qsoId`) REFERENCES `Qso`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QslEmail` ADD CONSTRAINT `QslEmail_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
