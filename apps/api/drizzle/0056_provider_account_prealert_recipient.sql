ALTER TABLE "provider_accounts" ADD COLUMN "prealert_recipient_id" text;--> statement-breakpoint
-- Los paquetes de clientes consolidados nacian sin bandera de prealerta (null =
-- "no aplica") porque no habia destinatario al que colgarla. Desde ahora se
-- prealertan con la cuenta exclusiva, asi que los que siguen esperando en Miami
-- pasan a 'pending' y la reconciliacion del robot los envia. Solo Prealertado: el
-- que ya llego a bodega no necesita aviso adelantado.
UPDATE "shipments"
SET "helga_prealert_status" = 'pending', "helga_prealert_attempts" = 0, "helga_prealert_error" = NULL
WHERE "provider_account_code" IS NOT NULL
  AND "helga_prealert_status" IS NULL
  AND "shipment_type" = 'paqueteria'
  AND "state" = 'prealertado'
  AND "discarded_at" IS NULL;
