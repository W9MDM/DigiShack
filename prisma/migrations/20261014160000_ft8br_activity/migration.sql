-- The FT8 Battle Royale activity feed, accumulated.
--
-- ft8battle.com publishes its last fifty events as JSON and its Steal Predictor embeds the
-- last couple of hours with the mode and the current holder. Neither goes further back, and
-- the bridge restarts several times a day, so what BR mode needs - who holds which station
-- on which band and mode TODAY - has to be kept here rather than in memory.
CREATE TABLE `Ft8brActivity` (
  `id`        VARCHAR(191) NOT NULL,
  `at`        DATETIME(3)  NOT NULL,
  `type`      VARCHAR(8)   NOT NULL,
  `station`   VARCHAR(20)  NOT NULL,
  `contact`   VARCHAR(20)  NOT NULL,
  `band`      VARCHAR(8)   NOT NULL,
  `mode`      VARCHAR(4)   NOT NULL,
  `points`    INTEGER      NULL,
  `victim`    VARCHAR(20)  NULL,
  `stolen`    INTEGER      NULL,
  `first`     BOOLEAN      NOT NULL DEFAULT false,
  `source`    VARCHAR(10)  NOT NULL,
  `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `Ft8brActivity_at_station_contact_band_mode_key`(`at`, `station`, `contact`, `band`, `mode`),
  INDEX `Ft8brActivity_at_idx`(`at`),
  INDEX `Ft8brActivity_contact_band_idx`(`contact`, `band`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
