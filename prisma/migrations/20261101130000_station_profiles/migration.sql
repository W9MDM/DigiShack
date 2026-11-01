-- Station profiles: per-station account settings and the active station.
-- Guarded throughout, like 20261101120000, so it applies to fresh and db-push installs.

CREATE TABLE IF NOT EXISTS `StationSetting` (
    `stationId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `value` TEXT NOT NULL,
    `encrypted` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`stationId`, `key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ActiveStation` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `stationId` VARCHAR(191) NOT NULL,
    `setById` VARCHAR(32) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `ActiveStation_stationId_fkey`(`stationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @db = DATABASE();

SET @s = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'StationSetting' AND CONSTRAINT_NAME = 'StationSetting_stationId_fkey') = 0,
  'ALTER TABLE `StationSetting` ADD CONSTRAINT `StationSetting_stationId_fkey` FOREIGN KEY (`stationId`) REFERENCES `Station`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'ActiveStation' AND CONSTRAINT_NAME = 'ActiveStation_stationId_fkey') = 0,
  'ALTER TABLE `ActiveStation` ADD CONSTRAINT `ActiveStation_stationId_fkey` FOREIGN KEY (`stationId`) REFERENCES `Station`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Record the home station once: the oldest, the one this install has always been. It owns
-- the original accounts, the .env fallbacks and data/lotw/cert.json (lib/station/scope.ts).
INSERT IGNORE INTO `Setting` (`key`, `value`, `encrypted`, `updatedAt`)
SELECT 'station.homeId', `id`, false, CURRENT_TIMESTAMP(3) FROM `Station` ORDER BY `createdAt` ASC LIMIT 1;

-- Today's account settings belong to the home station - and to any other station row with
-- the SAME callsign (K9XYZ at a second grid is still K9XYZ, with K9XYZ's QRZ and LoTW).
-- A station with a different callsign gets nothing and uploads nowhere until its own
-- accounts are entered. INSERT IGNORE: a re-run keeps anything edited since.
INSERT IGNORE INTO `StationSetting` (`stationId`, `key`, `value`, `encrypted`, `updatedAt`)
SELECT h.`id`, s.`key`, s.`value`, s.`encrypted`, CURRENT_TIMESTAMP(3)
FROM `Setting` s
JOIN (
  SELECT st.`id` FROM `Station` st
  JOIN (SELECT `callsign` FROM `Station` ORDER BY `createdAt` ASC LIMIT 1) hc ON st.`callsign` = hc.`callsign`
) h
WHERE s.`key` IN (
  'qrz.logbookApiKey', 'qrz.lastLogId',
  'lotw.username', 'lotw.password', 'lotw.station.state', 'lotw.station.county', 'lotw.station.canadian',
  'lotw.station.cqZone', 'lotw.station.ituZone', 'lotw.station.iota', 'lotw.lastQslSince', 'lotw.lastRunAt', 'lotw.lastResult',
  'eqsl.username', 'eqsl.password', 'eqsl.qthNickname', 'eqsl.lastSyncAt', 'eqsl.lastSyncResult',
  'clublog.email', 'clublog.password', 'clublog.appPassword', 'clublog.apiKey', 'clublog.callsign',
  'cloudlog.url', 'cloudlog.apiKey', 'cloudlog.stationProfileId'
);

-- The radio keeps operating as it always has until someone switches.
INSERT IGNORE INTO `ActiveStation` (`id`, `stationId`, `updatedAt`)
SELECT 1, `id`, CURRENT_TIMESTAMP(3) FROM `Station` ORDER BY `createdAt` ASC LIMIT 1;
