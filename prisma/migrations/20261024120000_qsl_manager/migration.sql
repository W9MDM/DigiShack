-- A user can be made the station's QSL manager: everything QSL, whatever their role.
ALTER TABLE `User` ADD COLUMN `qslManager` BOOLEAN NOT NULL DEFAULT false;
