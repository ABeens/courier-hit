/**
 * Esquemas Zod de entrada de los endpoints de auth. Viven en el dominio
 * compartido para que API (validacion) y web (formularios) usen la misma regla.
 * Reglas del backup: nombre no vacio, email con formato valido, contrasena >= 6.
 */
import { z } from 'zod';
import { isValidLocation } from '../geo/costa-rica';

/**
 * Cedula: se guarda normalizada a solo digitos. Costa Rica usa 9 digitos para la
 * cedula fisica, 10 para la juridica y 11-12 para DIMEX/extranjeros, asi que el
 * rango aceptado es 9-12. No validamos el digito verificador: el flag `nuevo`
 * del casillero existe para que un administrador revise el dato (docs/05 §2).
 */
export const idNumberSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => v.length >= 9 && v.length <= 12, 'La cédula debe tener entre 9 y 12 dígitos.');

/**
 * Telefono: todos los usuarios son de Costa Rica, cuyo plan nacional es de 8
 * digitos. Se acepta el prefijo +506 al escribir y se descarta al normalizar.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, '').replace(/^506(?=\d{8}$)/, ''))
  .refine((v) => /^\d{8}$/.test(v), 'El teléfono debe tener 8 dígitos.');

/**
 * Direccion de entrega en Costa Rica: la terna territorial del catalogo
 * compartido mas las "otras senas" en texto libre. Es la direccion a la que HS
 * Global reparte el paquete una vez nacionalizado; NUNCA viaja al proveedor
 * (docs/13 §3.6: hacia Helga va siempre la direccion fija de consolidacion).
 */
export const deliveryAddressShape = {
  provinceCode: z.string().trim().min(1, 'Elige la provincia.'),
  cantonCode: z.string().trim().min(1, 'Elige el cantón.'),
  districtCode: z.string().trim().min(1, 'Elige el distrito.'),
  addressLine: z
    .string()
    .trim()
    .min(5, 'Indica las otras señas de la dirección de entrega.')
    .max(500, 'Las otras señas no pueden superar 500 caracteres.'),
};

/**
 * La terna se valida contra el catalogo: no se confia en lo que manda el
 * cliente, ni siquiera en combinaciones cruzadas de codigos que existen por
 * separado pero no cuelgan uno del otro.
 */
function checkLocation(
  v: { provinceCode: string; cantonCode: string; districtCode: string },
  ctx: z.RefinementCtx,
): void {
  if (!isValidLocation(v.provinceCode, v.cantonCode, v.districtCode)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['districtCode'],
      message: 'La provincia, el cantón y el distrito no corresponden entre sí.',
    });
  }
}

export const deliveryAddressSchema = z.object(deliveryAddressShape).superRefine(checkLocation);
export type DeliveryAddressInput = z.infer<typeof deliveryAddressSchema>;

/**
 * Alta de customer (autoregistro publico). Solo crea principal = Client.
 * Campos exigidos por el requerimiento de creacion de casillero: nombre, cedula,
 * correo, telefono, direccion de entrega (Costa Rica), contrasena y aceptacion
 * expresa de terminos y politica de privacidad.
 */
export const registerSchema = z
  .object({
    name: z.string().trim().min(1, 'El nombre es obligatorio.'),
    idNumber: idNumberSchema,
    email: z.string().trim().toLowerCase().email('Correo electrónico inválido.'),
    phone: phoneSchema,
    ...deliveryAddressShape,
    password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres.'),
    // Debe ser un `true` explicito: un checkbox sin marcar no acepta nada.
    acceptsTerms: z.boolean().refine((v) => v, 'Debes aceptar los términos de uso y la política de privacidad.'),
  })
  .superRefine(checkLocation);
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
