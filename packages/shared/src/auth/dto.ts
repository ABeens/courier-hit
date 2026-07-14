/**
 * Esquemas Zod de entrada de los endpoints de auth. Viven en el dominio
 * compartido para que API (validacion) y web (formularios) usen la misma regla.
 * Reglas del backup: nombre no vacio, email con formato valido, contrasena >= 6.
 */
import { z } from 'zod';

/** Ciudades de destino soportadas (docs/05-modulo-usuarios.md §2). */
export const CITIES = ['Bogotá', 'Medellín', 'Cali', 'Barranquilla'] as const;
export type City = (typeof CITIES)[number];

/** Alta de customer (autoregistro publico). Solo crea principal = Client. */
export const registerSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio.'),
  email: z.string().trim().toLowerCase().email('Correo electrónico inválido.'),
  password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres.'),
  city: z.enum(CITIES).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

/** Confirmacion del codigo de 6 digitos enviado por email. */
export const verifySchema = z.object({
  email: z.string().trim().toLowerCase().email('Correo electrónico inválido.'),
  code: z.string().regex(/^\d{6}$/, 'El código son 6 dígitos.'),
});
export type VerifyInput = z.infer<typeof verifySchema>;

/** Login unico: customer y staff comparten mecanismo (docs/04 §2). */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Correo electrónico inválido.'),
  password: z.string().min(1, 'La contraseña es obligatoria.'),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Aceptar invitacion de staff: fija la contrasena a partir del token enviado por
 * correo (docs/roles.md §1.3.4). Al fijarla, la cuenta queda verificada.
 */
export const acceptInviteSchema = z.object({
  token: z.string().min(1, 'Token inválido.'),
  password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres.'),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
