-- QRZ Logbook confirms contacts, and DigiShack was treating it as a service that
-- only accepts them. It reports confirmation in APP_QRZLOG_STATUS and its own
-- record id in APP_QRZLOG_LOGID; without somewhere to put either, every sync
-- downloaded the whole logbook and every upload offered the whole log.
ALTER TABLE `Qso`
  ADD COLUMN `qrzRcvd` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `qrzLogId` INTEGER NULL;
