-- Opting out of QSL email.
--
-- Separate from DoNotCall on purpose: that list is about the radio, this one about the
-- mailbox. An operator glad to be worked weekly may still not want cards in their inbox,
-- and one who wants no further contacts may be perfectly happy to receive a card for the
-- ones already made. One table for both would honour neither request accurately.
--
-- Prompted by K2XYZ, who replied to a QSL email with the single word "Unsubscribe" — there
-- was no link to click, so he used the only mechanism he had. `source` records how each
-- request arrived, because a bare callsign with no explanation eventually gets deleted by
-- somebody assuming it was a mistake.
--
-- Written by hand and applied with `migrate deploy` — see the 20260805021500 note.
CREATE TABLE `QslOptOut` (
    `id` VARCHAR(191) NOT NULL,
    `callsign` VARCHAR(32) NOT NULL,
    `source` ENUM('MANUAL', 'LINK', 'QRZ_MARKER') NOT NULL DEFAULT 'MANUAL',
    `note` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `QslOptOut_callsign_key`(`callsign`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
