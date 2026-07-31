ALTER SEQUENCE "public"."hs_client_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1000 CACHE 1;--> statement-breakpoint
-- Paqueteria y carga: el consecutivo pasa de `HS` + 9 digitos a `HSX` + 9 digitos.
-- Se reescriben los codigos existentes para que la BD no mezcle los dos formatos;
-- el numero no cambia, solo el prefijo. `code` es UNIQUE y ningun `HSX...` existia
-- antes, asi que la actualizacion no puede chocar.
UPDATE "shipments" SET "code" = 'HSX' || substring("code" from 3) WHERE "code" ~ '^HS[0-9]{9}$';--> statement-breakpoint
-- `ALTER SEQUENCE ... START WITH` solo fija el valor de un RESTART futuro: el
-- contador vivo sigue donde estaba (la secuencia nacio en 1042). Hay que
-- reiniciarlo a mano.
--
-- Con guarda: si ya existen casilleros cuyo numero es >= 1000, reiniciar en 1000
-- haria que el registro de un cliente fallara contra el UNIQUE de `clients.code`
-- en cuanto la secuencia alcanzara un codigo ya usado. En ese caso se reinicia
-- justo despues del mayor codigo existente y se avisa por NOTICE. En una base
-- limpia (el caso normal) el primer casillero es HS-1000.
DO $$
DECLARE
  max_code bigint;
BEGIN
  SELECT max(NULLIF(regexp_replace(code, '\D', '', 'g'), '')::bigint)
    INTO max_code
    FROM clients;

  IF max_code IS NULL OR max_code < 1000 THEN
    ALTER SEQUENCE public.hs_client_code_seq RESTART WITH 1000;
  ELSE
    EXECUTE format('ALTER SEQUENCE public.hs_client_code_seq RESTART WITH %s', max_code + 1);
    RAISE NOTICE 'hs_client_code_seq: ya hay casilleros >= 1000 (max %); se reinicia en % en vez de 1000.',
      max_code, max_code + 1;
  END IF;
END $$;
