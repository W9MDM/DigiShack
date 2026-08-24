-- The "do not contact again" list.
--
-- A table rather than a setting, and the reason is what the list IS: somebody who has
-- asked not to be worked again has asked a person, and that request outlives any award
-- chase, settings reset or profile switch. It wants a reason and a date, because six
-- months later the reason is the only thing that explains the entry — and an operator who
-- cannot remember why a callsign is on the list will eventually delete it and call them.
--
-- `callsign` is UNIQUE and carries no separate index: the unique constraint is the index,
-- and the lookup is always by exact callsign. Upper-cased on write so the uniqueness is
-- real — "k9xyz" and "K9XYZ" are one station, and a case-sensitive list would silently
-- hold both and honour neither.
--
-- Written by hand and applied with `migrate deploy` — see the 20260805021500 note.
CREATE TABLE `DoNotCall` (
    `id` VARCHAR(191) NOT NULL,
    `callsign` VARCHAR(32) NOT NULL,
    `reason` VARCHAR(255) NULL,
    `addedBy` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DoNotCall_callsign_key`(`callsign`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
