/**
 * Esquemas Zod del modulo de casilleros.
 *
 * Dos ediciones distintas sobre la misma fila, con dueños distintos:
 *   - EL CLIENTE edita su contacto (Parte 2, "Editar Perfil": nombre, cedula,
 *     telefono; el correo hoy esta bloqueado). No toca tarifa ni limite de
 *     credito: son decisiones comerciales de HS Global.
 *   - EL ADMINISTRADOR edita la ficha entera (Parte 3, "Editar Cliente"): lo
 *     comercial (tarifa y limite de credito) y los datos del titular, correo
 *     incluido. El flag "Nuevo" no viaja en el cuerpo: se apaga solo al guardar,
 *     porque haber editado ES la revision.
 */
import { z } from 'zod';
import { Currency } from '../money/currency';
import { ClientReviewStatus, UserStatus } from '../auth/user';
import {
  checkLocation,
  deliveryAddressShape,
  emailSchema,
  idNumberSchema,
  nameSchema,
  phoneSchema,
} from '../auth/dto';
import { paginationQuerySchema } from '../http/pagination';

/**
 * Filtros del dashboard de casilleros (Parte 3).
 *
 * `reviewStatus` es filtro de SERVIDOR, no de navegador. Antes se aplicaba sobre
 * lo ya cargado con el argumento de que alternarlo no debia costar un viaje: eso
 * dejo de ser cierto al paginar, porque entonces solo recortaria la pagina
 * visible y el contador de "por revisar" contaria cincuenta filas en vez de
 * todas. La cola de nuevos es justo la que genera trabajo, asi que tiene que
 * salir completa.
 */
export const listClientsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(80).optional(),
    reviewStatus: z.nativeEnum(ClientReviewStatus).optional(),
    /**
     * Estado de la CUENTA (acceso), eje distinto de `reviewStatus`. Tambien es
     * filtro de servidor por la misma razon: los bloqueados son pocos y estan
     * repartidos por todas las paginas, asi que filtrar en el navegador solo
     * encontraria los que cayeron en la pagina visible.
     */
    status: z.nativeEnum(UserStatus).optional(),
  })
  .merge(paginationQuerySchema);
export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;

/**
 * Alta de un casillero por un administrador (permiso `clients.write`), para el
 * cliente que no se registra solo desde el sitio (llama, escribe, viene a la
 * oficina).
 *
 * Pide lo mismo que el autoregistro menos la contrasena y la aceptacion de
 * terminos: el administrador nunca fija la contrasena (se le manda una
 * invitacion al titular) y los terminos los acepta el titular, no el staff.
 */
export const createClientSchema = z
  .object({
    name: nameSchema,
    idNumber: idNumberSchema,
    email: emailSchema,
    phone: phoneSchema,
    ...deliveryAddressShape,
  })
  .superRefine(checkLocation);
export type CreateClientInput = z.infer<typeof createClientSchema>;

/** Respuesta del alta. `inviteLink` solo viene en desarrollo (en produccion va por correo). */
export interface CreateClientResultDto {
  id: string;
  code: string;
  name: string;
  inviteLink?: string;
}

/**
 * Bloqueo / reactivacion del acceso de un casillero (permiso `clients.suspend`).
 *
 * Cuerpo propio y endpoint propio, no un campo mas de `updateClientSchema`, por
 * dos razones:
 *
 *   1. El permiso es otro. Editar la ficha es `clients.write`; cerrar la puerta
 *      es `clients.suspend`, y un mismo esquema no puede pedir dos permisos.
 *   2. Editar ES revisar: `updateClientSchema` apaga el flag "Nuevo" al guardar.
 *      Bloquear a un cliente no es haberlo revisado, y con el campo aqui dentro
 *      lo daria por revisado sin que nadie mirara sus datos.
 */
export const setClientStatusSchema = z.object({
  status: z.nativeEnum(UserStatus),
});
export type SetClientStatusInput = z.infer<typeof setClientStatusSchema>;

/**
 * Habilitacion del ACCESO A LA API de un casillero (permiso
 * `clients.api_access`). Nace apagado para todos: la integracion por llaves no
 * viene con la cuenta, la enciende un administrador cuando se contrata y la
 * apaga cuando deja de estarlo.
 *
 * Cuerpo y endpoint propios por lo mismo que el bloqueo de acceso: es otro
 * permiso, y no puede colarse por `updateClientSchema`, que al guardar da el
 * casillero por revisado. Es un booleano explicito y no un "toggle" sin cuerpo
 * para que la peticion sea idempotente: reintentarla no deja el interruptor al
 * reves de lo que se quiso.
 */
export const setClientApiAccessSchema = z.object({
  enabled: z.boolean(),
});
export type SetClientApiAccessInput = z.infer<typeof setClientApiAccessSchema>;

/**
 * EXENCION DE LA RETENCION POR PAGO de un casillero (permiso
 * `clients.payment_exempt`). Con ella encendida sus paquetes salen a ruta sin el
 * pago confirmado; el aviso se sigue mostrando, pero no bloquea. A que flows
 * aplica lo decide `paymentGateWaived`, no el casillero.
 *
 * Cuerpo y endpoint propios por lo mismo que la API: otro permiso, y no puede dar
 * el casillero por revisado. Booleano explicito para que sea idempotente.
 */
export const setClientPaymentExemptSchema = z.object({
  enabled: z.boolean(),
});
export type SetClientPaymentExemptInput = z.infer<typeof setClientPaymentExemptSchema>;

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

/** Campos de la direccion de entrega: viajan los cuatro juntos o ninguno. */
const ADDRESS_KEYS = ['provinceCode', 'cantonCode', 'districtCode', 'addressLine'] as const;

/**
 * Edicion de la ficha completa por el administrador (permiso `clients.write`):
 * lo comercial (tarifa, limite de credito) y tambien los datos del titular
 * (nombre, cedula, correo, telefono y direccion de entrega).
 *
 * Todos los campos son opcionales pero al menos uno debe venir. La moneda es
 * obligatoria SIEMPRE que venga un limite distinto de null: un techo sin moneda
 * no significa nada (regla M2). La direccion, igual que en el perfil del
 * cliente, solo se acepta COMPLETA y validada contra el catalogo: un PATCH
 * parcial podria dejar un canton que no cuelga de la provincia guardada.
 *
 * Correo y cedula son los dos datos delicados (el correo es el usuario de login;
 * la cedula identifica al casillero ante el proveedor): la web pide confirmarlos
 * aparte y la API revisa que no los tenga otra cuenta. Ver `clientsService.update`.
 */
export const updateClientSchema = z
  .object({
    clientRateId: z.string().uuid('Elige una tarifa válida.').optional(),
    creditLimit: creditLimitSchema.nullable().optional(),
    creditLimitCurrency: z.nativeEnum(Currency).nullable().optional(),
    name: nameSchema.optional(),
    idNumber: idNumberSchema.optional(),
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    provinceCode: deliveryAddressShape.provinceCode.optional(),
    cantonCode: deliveryAddressShape.cantonCode.optional(),
    districtCode: deliveryAddressShape.districtCode.optional(),
    addressLine: deliveryAddressShape.addressLine.optional(),
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

    const present = ADDRESS_KEYS.filter((k) => data[k] !== undefined);
    if (present.length > 0 && present.length < ADDRESS_KEYS.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['districtCode'],
        message: 'La dirección de entrega se guarda completa: provincia, cantón, distrito y señas.',
      });
    } else if (present.length === ADDRESS_KEYS.length) {
      checkLocation(
        { provinceCode: data.provinceCode!, cantonCode: data.cantonCode!, districtCode: data.districtCode! },
        ctx,
      );
    }
  });
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

/**
 * Edicion del propio perfil por el cliente (Parte 2, "Editar Perfil": nombre,
 * cedula, telefono y correo).
 *
 * La direccion NO esta aqui: se edita por su propio endpoint
 * (`PATCH /clients/me/address`, esquema `deliveryAddressSchema`) porque no es un
 * dato de contacto mas. Dos motivos la separan del resto:
 *
 *   1. Es una TERNA indivisible (provincia/canton/distrito) mas las señas: un
 *      PATCH parcial permitiria dejar un canton que no cuelga de la provincia.
 *   2. Tiene una PRECONDICION propia: solo se puede mover si el casillero no
 *      tiene tramites en curso, porque el distrito determina la ruta de reparto
 *      y la hoja del mensajero lee la direccion en vivo. Ver
 *      `clientsService.updateAddress`.
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
