-- CreateTable
CREATE TABLE `OperatorShift` (
    `id` VARCHAR(191) NOT NULL,
    `operatorId` VARCHAR(191) NOT NULL,
    `signedOnBy` VARCHAR(32) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,

    INDEX `OperatorShift_endedAt_idx`(`endedAt`),
    INDEX `OperatorShift_operatorId_idx`(`operatorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Qso_updatedAt_id_idx` ON `Qso`(`updatedAt`, `id`);

-- AddForeignKey
ALTER TABLE `OperatorShift` ADD CONSTRAINT `OperatorShift_operatorId_fkey` FOREIGN KEY (`operatorId`) REFERENCES `Operator`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

