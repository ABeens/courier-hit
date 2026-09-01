/**
 * Cuentas del proveedor de casillero (Helga): contrato compartido entre la API y
 * la pantalla de mantenimiento del administrador.
 *
 * EL PROBLEMA QUE RESUELVE. Hasta ahora el sistema hablaba con UNA sola cuenta de
 * Helga, la principal de HS Global, bajo la que cuelgan como sub-casilleros todos
 * los clientes que se registran en el landing. Hay un tipo de cliente que no cabe
 * ahi: el CONSOLIDADO (o "exclusivo"), una empresa con su propia cuenta dedicada
 * dentro de Helga, creada a mano por un administrador del lado del proveedor. Su
 * paqueteria no llega repartida entre sub-casilleros de varios clientes nuestros:
 * TODA la cuenta es de un unico cliente, vengan sus paquetes de uno o de veinte
 * sub-casilleros.
 *
 * DOS TIPOS DE CUENTA, UNA SOLA REGLA CADA UNA:
 *
 *   - la PRINCIPAL reparte sus paquetes entre muchos clientes, cruzando el
 *     `destinatario_id` de cada paquete contra el casillero de cada cliente. Es
 *     la de siempre y no cambia nada;
 *   - una cuenta EXCLUSIVA no cruza nada: todo lo que trae es de su cliente
 *     consolidado. La relacion cuenta <-> cliente es 1 a 1.
 *
 * LO QUE NO ENTRA AQUI. Las credenciales (contrasena y `client_secret`) NUNCA
 * viajan de vuelta al portal: se escriben una vez y se guardan cifradas. Lo que
 * el panel ve de ellas es si estan puestas, nunca su valor.
 */
import { z } from 'zod';
import { checkLocation, deliveryAddressShape, emailSchema, idNumberSchema, nameSchema, phoneSchema } from '../auth/dto';

/**
 * De que tipo es la cuenta de Helga.
 *
 * Es dominio, asi que va en espanol. La distincion no es cosmetica: decide como
 * se le atribuye dueno a cada paquete que la cuenta trae (ver arriba).
 */
export enum ProviderAccountKind {
  /** La cuenta madre de HS Global. Una sola, y vive en la configuracion. */
  Principal = 'principal',
  /** Cuenta dedicada de un cliente consolidado. Viven en la base de datos. */
  Exclusiva = 'exclusiva',
}

export const PROVIDER_ACCOUNT_KIND_LABELS: Record<ProviderAccountKind, string> = {
  [ProviderAccountKind.Principal]: 'Principal',
  [ProviderAccountKind.Exclusiva]: 'Exclusiva',
};

/**
 * Codigo de casillero del proveedor, p. ej. `SJO009623`. Es lo que identifica la
 * cuenta ante Helga y lo que se guarda como origen en cada paquete importado.
 *
 * Se normaliza a mayusculas porque el proveedor lo escribe asi y porque el
 * codigo acaba comparandose contra el que viene en los paquetes: dos grafias del
 * mismo casillero serian dos origenes distintos para el sistema.
 */
export const providerAccountCodeSchema = z
  .string()
  .trim()
  .min(3, 'El código de casillero es obligatorio.')
  .max(40, 'El código de casillero es demasiado largo.')
  .transform((v) => v.toUpperCase());

const accountNameSchema = z
  .string()
  .trim()
  .min(2, 'Indica a nombre de quién está la cuenta.')
  .max(120, 'El nombre de la cuenta es demasiado largo.');

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'El usuario (o correo) de la cuenta es obligatorio.')
  .max(200, 'El usuario de la cuenta es demasiado largo.');

const passwordSchema = z
  .string()
  .min(1, 'La contraseña de la cuenta es obligatoria.')
  .max(200, 'La contraseña es demasiado larga.');

/**
 * `cliente_id` de la cuenta dentro de Helga: el `datos.id` que devuelve
 * `GET /api/casillero/clientes` con el token de ESA cuenta.
 *
 * Es opcional porque solo hace falta para dar de alta destinatarios (op. D), y
 * una cuenta exclusiva no da de alta ninguno: sus sub-casilleros los crea el
 * administrador del proveedor. Se captura igual porque es el dato que permitiria
 * usarla algun dia para lo mismo que la principal.
 */
const providerCustomerIdSchema = z
  .number()
  .int('El id de cliente en Helga es un número entero.')
  .positive('El id de cliente en Helga debe ser positivo.');

/**
 * Credenciales de aplicacion PROPIAS de la cuenta.
 *
 * Hoy el `client_id` y el `client_secret` son de la APLICACION y se comparten
 * entre todas las cuentas de HS Global (docs/13 §1.1); lo que cambia por cuenta
 * es el usuario y la contrasena. Se capturan igual, y opcionales, porque una
 * cuenta exclusiva es de otra empresa y no hay ninguna garantia de que el
 * proveedor le de las mismas: vacias, la cuenta usa las de la aplicacion.
 */
const appCredentialsShape = {
  oauthClientId: z.string().trim().max(80).optional(),
  oauthClientSecret: z.string().trim().max(300).optional(),
  appId: z.string().trim().max(300).optional(),
};

/** Alta de una cuenta exclusiva. La principal no se crea: ya existe en el .env. */
export const createProviderAccountSchema = z.object({
  code: providerAccountCodeSchema,
  name: accountNameSchema,
  username: usernameSchema,
  password: passwordSchema,
  providerCustomerId: providerCustomerIdSchema.nullable().optional(),
  ...appCredentialsShape,
});
export type CreateProviderAccountInput = z.infer<typeof createProviderAccountSchema>;

/**
 * Edicion de una cuenta exclusiva.
 *
 * Los secretos son opcionales y "no mandarlos" significa DEJARLOS COMO ESTAN, no
 * borrarlos: el panel nunca los recibe, asi que no puede reenviarlos, y un
 * formulario que los mandara vacios dejaria la cuenta sin poder autenticarse.
 */
export const updateProviderAccountSchema = z
  .object({
    name: accountNameSchema.optional(),
    username: usernameSchema.optional(),
    password: passwordSchema.optional(),
    providerCustomerId: providerCustomerIdSchema.nullable().optional(),
    /** Apagar la cuenta la saca del recorrido de importacion sin borrar nada. */
    active: z.boolean().optional(),
    ...appCredentialsShape,
  })
  .refine((v) => Object.keys(v).length > 0, 'No hay nada que actualizar.');
export type UpdateProviderAccountInput = z.infer<typeof updateProviderAccountSchema>;

/**
 * Alta del CLIENTE CONSOLIDADO de una cuenta exclusiva.
 *
 * Es el unico camino por el que nace un cliente de este tipo (regla de negocio:
 * ni el landing lo ofrece, ni un cliente existente se puede convertir), y por eso
 * el alta cuelga de la cuenta y no del modulo de clientes.
 *
 * Pide lo mismo que el autoregistro MENOS la contrasena: el administrador nunca
 * la fija, se manda una invitacion para que el titular la defina (docs/roles.md
 * §1.3.4, igual que el staff).
 */
export const createConsolidatedClientSchema = z
  .object({
    name: nameSchema,
    idNumber: idNumberSchema,
    email: emailSchema,
    phone: phoneSchema,
    ...deliveryAddressShape,
  })
  .superRefine(checkLocation);
export type CreateConsolidatedClientInput = z.infer<typeof createConsolidatedClientSchema>;

/** El cliente consolidado de una cuenta, tal como lo muestra el panel. */
export interface ProviderAccountClientDto {
  id: string;
  /** Casillero interno, p. ej. `HS-1042`. */
  code: string;
  name: string;
  email: string;
}

/**
 * Una cuenta del proveedor vista desde el panel.
 *
 * `id` es `null` en la principal: no es una fila de la base, es la cuenta que
 * viene de la configuracion del despliegue. Se lista igual (y de solo lectura)
 * porque el administrador tiene que ver contra que cuentas trabaja el sistema,
 * no solo las que el dio de alta.
 */
export interface ProviderAccountDto {
  id: string | null;
  kind: ProviderAccountKind;
  code: string;
  name: string;
  username: string;
  providerCustomerId: number | null;
  /** True si la cuenta trae `client_id`/`client_secret` propios (no los de la app). */
  hasOwnAppCredentials: boolean;
  active: boolean;
  /** El cliente consolidado al que se le atribuye TODA la paqueteria de la cuenta. */
  client: ProviderAccountClientDto | null;
  /** Ultima corrida de importacion sobre esta cuenta, y como le fue. */
  lastImportAt: string | null;
  lastImportError: string | null;
  createdAt: string | null;
}

export interface ProviderAccountListDto {
  items: ProviderAccountDto[];
}

/**
 * Respuesta del alta del cliente consolidado.
 *
 * `inviteLink` solo viaja en desarrollo, igual que en el alta de staff: en
 * produccion el enlace para fijar la contrasena va UNICAMENTE por correo.
 */
export interface CreateConsolidatedClientResultDto {
  account: ProviderAccountDto;
  inviteLink?: string;
}
