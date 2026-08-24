-- The bridge is not "omega".
--
-- wsjtx-omega is one program the bridge can take decodes FROM. It has nothing to do
-- with the FlexRadio and Icom paths, which decode and transmit in-process, and naming
-- the whole service after it made the settings read as though an external program were
-- always involved.
--
-- Split in two: the bridge's own settings become `bridge.*`, and the ones that really
-- are about an external WSJT-X-protocol decoder become `wsjtx.*`.
--
-- Renaming the rows rather than copying them: two rows for one setting would let an
-- edit to the old key silently win on an install that had not been restarted. The
-- registry also reads the old key when the new one is missing (SettingDef.legacyKeys),
-- which covers a database that predates this migration.

-- The bridge itself.
UPDATE `Setting` SET `key` = 'bridge.port'   WHERE `key` = 'omega.bridgePort';
UPDATE `Setting` SET `key` = 'bridge.token'  WHERE `key` = 'omega.bridgeToken';
UPDATE `Setting` SET `key` = 'bridge.wsUrl'  WHERE `key` = 'omega.bridgeWsUrl';

-- The external decoder.
UPDATE `Setting` SET `key` = 'wsjtx.udpPort' WHERE `key` = 'omega.udpPort';
UPDATE `Setting` SET `key` = 'wsjtx.udpHost' WHERE `key` = 'omega.udpHost';
UPDATE `Setting` SET `key` = 'wsjtx.autoLog' WHERE `key` = 'omega.autoLog';

-- And the source selection itself. The bridge still accepts the old value.
UPDATE `Setting` SET `value` = 'wsjtx' WHERE `key` = 'digital.source' AND `value` = 'omega';
