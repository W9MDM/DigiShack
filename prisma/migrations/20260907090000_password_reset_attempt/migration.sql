-- Every "forgot password" request, whatever came of it.
--
-- PasswordReset records issued TOKENS, so it only ever holds the successful case for a real
-- account. The rows an operator debugging "no email arrived" needs are the other ones: an
-- address with no account, a throttled request, an SMTP failure. None of those creates a
-- token, so none of them was recorded anywhere.
CREATE TABLE `PasswordResetAttempt` (
  `id`        VARCHAR(191) NOT NULL,
  `email`     VARCHAR(190) NOT NULL,
  `ip`        VARCHAR(45)  NULL,
  `outcome`   VARCHAR(16)  NOT NULL,
  `detail`    VARCHAR(255) NULL,
  `userAgent` VARCHAR(255) NULL,
  `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `PasswordResetAttempt_createdAt_idx`(`createdAt`),
  INDEX `PasswordResetAttempt_email_idx`(`email`),
  INDEX `PasswordResetAttempt_ip_idx`(`ip`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
