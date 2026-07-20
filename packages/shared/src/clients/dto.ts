/**
 * Esquemas Zod del modulo de casilleros.
 *
 * Dos ediciones distintas sobre la misma fila, con dueños distintos:
 *   - EL CLIENTE edita su contacto (Parte 2, "Editar Perfil": nombre, cedula,
 *     telefono, correo). No toca tarifa ni limite de credito: son decisiones
 *     comerciales de HS Global.
 *   - EL ADMINISTRADOR edita lo comercial (Parte 3, "Editar Cliente": tarifa y
 *     limite de credito). El flag "Nuevo" no viaja en el cuerpo: se apaga solo
 *     al guardar, porque haber editado ES la revision.
 */
import { z } from 'zod';
import { Currency } from '../money/currency';
import { emailSchema, idNumberSchema, nameSchema, phoneSchema } from '../auth/dto';

/**
 * Limite de credito del casillero (Parte 3 L48: "ingresarles un límite de
 * crédito"). Es un TECHO de politica comercial, no un monto transaccional: por
 * eso lleva moneda explicita (regla M2) pero no tasa de cambio (no hay un
 * instante de "cobro" que congelar; ver la nota del campo en money-rules).
 *
 * `null` significa sin limite definido, que no es lo mismo que un limite de 0
 * (ese seria un cliente al que no se le fia nada).
 */
export const creditLimitSchema = z
  .number({ invalid_type_error: 'El límite de crédito debe ser un número.' })
  .nonnegative('El límite de crédito no puede ser negativo.')
  .max(1_000_000_000, 'El límite de crédito es demasiado grande.');

/**
 * Edicion comercial por el administrador. Todos los campos son opcionales pero
 * al menos uno debe venir. La moneda es obligatoria SIEMPRE que venga un limite
 * distinto de null: un techo sin moneda no significa nada (regla M2).
 */
export const updateClientSchema = z
  .object({
    clientRateId: z.string().uuid('Elige una tarifa válida.').optional(),
    creditLimit: creditLimitSchema.nullable().optional(),
    creditLimitCurrency: z.nativeEnum(Currency).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No hay cambios que aplicar.' })
  .superRefine((data, ctx) => {
    if (data.creditLimit != null && data.creditLimitCurrency == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['creditLimitCurrency'],
        message: 'Elige la moneda del límite de crédito.',
      });
    }
  });
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

/**
 * Edicion del propio perfil por el cliente (Parte 2, "Editar Perfil": nombre,
 * cedula, telefono y correo).
 *
 * La direccion NO esta aqui a proposito: el distrito determina la ruta de
 * reparto (asociacion 1 a 1 con las rutas del panel admin), asi que moverla es
 * una decision operativa y no un dato de contacto.
 *
 * Cambiar el correo cambia el USUARIO DE LOGIN, asi que la API lo trata aparte:
 * exige verificar la nueva direccion antes de volver a dar acceso. Ver
 * `clientsService.updateProfile`.
 */
export const updateProfileSchema = z
  .object({
    name: nameSchema.optional(),
    idNumber: idNumberSchema.optional(),
    phone: phoneSchema.optional(),
    email: emailSchema.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No hay cambios que aplicar.' });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
