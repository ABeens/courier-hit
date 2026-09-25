-- Las proformas caen con su casillero, como sus cobros (payment_groups). Solo
-- pasa en limpiezas de datos de prueba; sin la cascada el reset de los seeds
-- (que borra clientes) quedaba trabado.
ALTER TABLE "proformas" DROP CONSTRAINT "proformas_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "proformas" ADD CONSTRAINT "proformas_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;