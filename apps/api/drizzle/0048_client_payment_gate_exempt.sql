-- Exencion de la retencion por pago del casillero (permiso clients.payment_exempt).
-- Nace apagada: por regla, un paquete no sale a ruta sin el pago confirmado.
ALTER TABLE "clients" ADD COLUMN "payment_gate_exempt" boolean DEFAULT false NOT NULL;