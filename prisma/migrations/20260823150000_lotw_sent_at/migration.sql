-- When a contact was uploaded to LoTW.
--
-- `lotwSent` on its own is optimistic and cannot be checked. An accepted LoTW upload answers
-- "File <name>.tq8 queued for processing" — QUEUED, not stored. The records are validated
-- afterwards and the outcome arrives by email, so if LoTW refuses some of them the flag here
-- still says sent, nothing retries, and the contacts are missing from the operator's LoTW log
-- with everything looking fine. That is the worst failure shape available.
--
-- Reconciliation asks LoTW what it actually holds, via `lotwreport.adi` with
-- `qso_qsl=no&qso_qsorxsince=<date>` — a query bounded by RECEIPT date. So the local side
-- needs the same bound, and no other column carries it: `startTime` is when the contact
-- happened, which for a back catalogue is years earlier.
--
-- NULL for every contact marked sent before this existed. That is deliberate and load-bearing:
-- those flags cannot be placed inside or outside any window, and treating an unknown date as
-- "in the window" would report the whole back catalogue as missing and un-mark all of it.
-- Reconciliation skips them.
--
-- Written by hand and applied with `migrate deploy` — see the 20260805021500 note.
ALTER TABLE `Qso` ADD COLUMN `lotwSentAt` DATETIME(3) NULL;

-- Indexed with the flag it qualifies, because every reconciliation query is
-- "lotwSent = true AND lotwSentAt >= ?".
CREATE INDEX `Qso_lotwSent_lotwSentAt_idx` ON `Qso`(`lotwSent`, `lotwSentAt`);
