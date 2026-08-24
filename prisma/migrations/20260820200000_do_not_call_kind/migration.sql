-- Two kinds of entry on one list.
--
-- The list shipped as "never call them", which is the stronger of two requests people
-- actually make and the wrong one for the case that prompted it. K1XYZ asked not to be
-- worked TWICE on the same band and mode, and said in the same message "Feel free to make
-- another contact with me if it is not a duplicate. I would rather work a new station or
-- someone I've worked before on a different band/mode." Recording that as NEVER would
-- honour more than he asked; recording it as a station-wide rule would impose his
-- preference on everybody else, which was tried in 1.83.0 and is not wanted.
--
-- So: per-callsign, two kinds. NEVER is the default because an entry whose intent was not
-- recorded should fail safe toward calling less.
--
-- Existing rows keep NEVER, which is what they were created as and what they meant.
--
-- Written by hand and applied with `migrate deploy` — see the 20260805021500 note.
ALTER TABLE `DoNotCall`
  ADD COLUMN `kind` ENUM('NEVER', 'NO_DUPES') NOT NULL DEFAULT 'NEVER';
