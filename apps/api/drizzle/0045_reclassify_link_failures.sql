-- 'failed' pasa a significar "el proveedor rechazo el dato" y el robot deja de
-- reintentarlo. Hasta ahora tambien caian ahi las caidas, la lista blanca y las
-- credenciales, que si se curan solas: esos vuelven a 'pending' para que el
-- robot los siga intentando. Se reconocen porque su ultimo error no es un
-- rechazo del dato (ProviderErrors.validation).
UPDATE "clients"
SET "helga_sync_status" = 'pending'
WHERE "helga_sync_status" = 'failed'
  AND ("helga_last_error" IS NULL OR "helga_last_error" NOT LIKE 'El operador en Miami rechazó los datos%');
