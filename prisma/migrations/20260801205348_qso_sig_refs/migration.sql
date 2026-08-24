-- CreateTable
CREATE TABLE `QsoSigRef` (
    `id` VARCHAR(191) NOT NULL,
    `qsoId` VARCHAR(191) NOT NULL,
    `sig` VARCHAR(32) NOT NULL,
    `sigInfo` VARCHAR(32) NOT NULL,
    `primary` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `QsoSigRef_sigInfo_idx`(`sigInfo`),
    INDEX `QsoSigRef_sig_sigInfo_idx`(`sig`, `sigInfo`),
    INDEX `QsoSigRef_qsoId_idx`(`qsoId`),
    UNIQUE INDEX `QsoSigRef_qsoId_sig_sigInfo_key`(`qsoId`, `sig`, `sigInfo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `QsoSigRef` ADD CONSTRAINT `QsoSigRef_qsoId_fkey` FOREIGN KEY (`qsoId`) REFERENCES `Qso`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
