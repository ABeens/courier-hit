-- La cuenta bancaria pasa de identificar un BANCO ('BAC', 'BCR') a identificar una
-- CUENTA concreta: cada banco tiene una en dolares y otra en colones, con numeros
-- distintos. Ver packages/shared/src/payments/payment.ts (BANK_ACCOUNTS).
--
-- Los abonos ya registrados se remapean por SU PROPIA MONEDA, que es el unico dato
-- que dice a cual de las dos cuentas del banco entro el dinero. El cast directo que
-- genera drizzle-kit fallaria: 'BAC' no es un valor del enum nuevo.
ALTER TABLE "public"."payments" ALTER COLUMN "bank_account" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."bank_account";--> statement-breakpoint
CREATE TYPE "public"."bank_account" AS ENUM('bac_usd', 'bac_crc', 'bcr_usd', 'bcr_crc');--> statement-breakpoint
UPDATE "payments"
SET "bank_account" = lower("bank_account") || CASE WHEN "currency" = 'USD' THEN '_usd' ELSE '_crc' END
WHERE "bank_account" IN ('BAC', 'BCR');--> statement-breakpoint
ALTER TABLE "public"."payments" ALTER COLUMN "bank_account" SET DATA TYPE "public"."bank_account" USING "bank_account"::"public"."bank_account";
