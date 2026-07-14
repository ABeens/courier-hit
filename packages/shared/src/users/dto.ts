/**
 * Esquemas Zod de la gestion de staff (panel admin, permiso users.manage).
 * Fuente: docs/roles.md §1.3, docs/05-modulo-usuarios.md §3.
 *
 * Reglas del cliente: nombre no vacio, email valido y unico, telefono opcional,
 * rol obligatorio (uno de los 5 roles de staff, nunca `client`). El admin NUNCA
 * fija contrasenas: al crear se envia invitacion (docs/roles.md §1.3.4).
 */
import { z } from 'zod';
import { Role } from '../auth/roles';
import { UserStatus } from '../auth/user';

/** Rol asignable a staff: cualquiera menos `client` (docs/roles.md §1.3.3). */
export const staffRoleSchema = z
  .nativeEnum(Role)
  .refine((r) => r !== Role.Client, { message: 'El rol debe ser un rol de staff.' });

/** Crear staff. El estado nace Activo (docs/roles.md §1.3.3); no se pide contrasena. */
export const createStaffSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio.'),
  email: z.string().trim().toLowerCase().email('Correo electrónico inválido.'),
  phone: z.string().trim().min(1).optional(),
  role: staffRoleSchema,
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;

/**
 * Editar staff. Todos los campos opcionales pero al menos uno presente.
 * `phone: null` limpia el telefono. El cambio de rol aplica en el proximo
 * request (la sesion se reconstruye desde la BD); deshabilitar revoca sesion.
 */
export const updateStaffSchema = z
  .object({
    name: z.string().trim().min(1, 'El nombre es obligatorio.').optional(),
    phone: z.string().trim().min(1).nullable().optional(),
    role: staffRoleSchema.optional(),
    status: z.nativeEnum(UserStatus).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No hay cambios que aplicar.' });
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

/** Filtros del listado de staff: busqueda por nombre/correo + rol + estado. */
export const listStaffQuerySchema = z.object({
  q: z.string().trim().optional(),
  role: staffRoleSchema.optional(),
  status: z.nativeEnum(UserStatus).optional(),
});
export type ListStaffQuery = z.infer<typeof listStaffQuerySchema>;
