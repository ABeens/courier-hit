-- Un sub-casillero, un casillero: dos casilleros con la misma direccion de Miami
-- se reparten los paquetes del otro. Si esta migracion falla con "could not
-- create unique index ... is duplicated", ya hay duplicados en la base: hay que
-- resolverlos a mano (ver docs/13) antes de aplicarla.
CREATE UNIQUE INDEX "clients_helga_sub_locker_uq" ON "clients" USING btree ("helga_sub_locker");
