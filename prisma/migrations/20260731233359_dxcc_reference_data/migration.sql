-- CreateTable
CREATE TABLE `DxccEntity` (
    `adif` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `prefix` VARCHAR(16) NOT NULL,
    `deleted` BOOLEAN NOT NULL DEFAULT false,
    `cqZone` INTEGER NULL,
    `continent` VARCHAR(4) NULL,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `validFrom` DATETIME(3) NULL,
    `validTo` DATETIME(3) NULL,

    INDEX `DxccEntity_name_idx`(`name`),
    INDEX `DxccEntity_prefix_idx`(`prefix`),
    INDEX `DxccEntity_deleted_idx`(`deleted`),
    PRIMARY KEY (`adif`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DxccPrefix` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `call` VARCHAR(32) NOT NULL,
    `exact` BOOLEAN NOT NULL DEFAULT false,
    `adif` INTEGER NOT NULL,
    `cqZone` INTEGER NULL,
    `continent` VARCHAR(4) NULL,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `validFrom` DATETIME(3) NULL,
    `validTo` DATETIME(3) NULL,

    INDEX `DxccPrefix_call_exact_idx`(`call`, `exact`),
    INDEX `DxccPrefix_adif_idx`(`adif`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DxccPrefix` ADD CONSTRAINT `DxccPrefix_adif_fkey` FOREIGN KEY (`adif`) REFERENCES `DxccEntity`(`adif`) ON DELETE CASCADE ON UPDATE CASCADE;
