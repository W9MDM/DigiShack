-- Settings named after one radio that were never about that radio.
--
-- `operating.ts` builds the SAME operating layer for the FlexRadio and the Icom, and it
-- read band hopping and hunt preferences from `flex.*` keys for both. On the Icom that
-- meant the Settings page offered "FlexRadio" options that governed an Icom, which is
-- the sort of thing an operator reasonably assumes is a bug and works around.
--
-- Which digital mode to decode is the same story: a property of the operating, not of
-- the radio, and the Icom needs the same answer.
--
-- The registry reads the old keys when the new ones are unset (SettingDef.legacyKeys),
-- so an install that has not run this keeps working.
UPDATE `Setting` SET `key` = 'auto.bandHop'     WHERE `key` = 'flex.bandHop';
UPDATE `Setting` SET `key` = 'auto.hopBands'    WHERE `key` = 'flex.hopBands';
UPDATE `Setting` SET `key` = 'auto.huntNewOnly' WHERE `key` = 'flex.huntNewOnly';
UPDATE `Setting` SET `key` = 'auto.huntMinSnr'  WHERE `key` = 'flex.huntMinSnr';
UPDATE `Setting` SET `key` = 'digital.mode'     WHERE `key` = 'flex.mode';
