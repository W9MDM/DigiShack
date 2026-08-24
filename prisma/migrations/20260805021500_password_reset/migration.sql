-- One-time password-reset tokens, emailed to the account address.
--
-- Written by hand and applied with `migrate deploy`: `migrate dev` refuses this
-- database because the 1.54.1 table-case fix edited applied migrations (see the
-- CHANGELOG entry, which predicted exactly this). Table name matches the created
-- case everywhere — the 1.54.1 lesson.
CREATE TABLE `PasswordReset` (
    `id` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PasswordReset_tokenHash_key`(`tokenHash`),
    INDEX `PasswordReset_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PasswordReset` ADD CONSTRAINT `PasswordReset_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
