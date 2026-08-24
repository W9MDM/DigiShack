-- Which radio made the contact.
--
-- Not a foreign key to `Rig`: that table is operator-entered inventory that nothing in
-- the radio path reads, and requiring a row there before a contact could record what
-- keyed it would mean most contacts recorded nothing. This is what the radio called
-- itself over its own control interface.
ALTER TABLE `Qso` ADD COLUMN `radio` VARCHAR(64) NULL;

-- "Which radio was this worked on" is a question with a handful of answers across
-- tens of thousands of rows, which is exactly what an index is for.
CREATE INDEX `Qso_radio_idx` ON `Qso`(`radio`);
