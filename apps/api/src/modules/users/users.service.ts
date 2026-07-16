/**
 * Gestion de staff (permiso users.manage, solo admin). Reglas de docs/roles.md §1.3:
 *   - email unico global; el admin nunca fija contrasenas (se envia invitacion).
 *   - "deshabilitar, no eliminar": no hay DELETE; se conmuta el estado.
 *   - no dejar el sistema sin admin activo (ultimo admin protegido).
 *   - al deshabilitar, la sesion del usuario se revoca de inmediato.
 */
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { Principal, Role, UserStatus } from '@courier/shared';
import type { CreateStaffInput, ListStaffQuery, UpdateStaffInput } from '@courier/shared';
import { AuthErrors, UserErrors } from '../../core/errors';
import { authRepo } from '../auth/auth.repo';
import { authService } from '../auth/auth.service';
import { usersRepo } from './users.repo';

export const usersService = {
  async list(query: ListStaffQuery) {
    const [items, counts] = await Promise.all([usersRepo.listStaff(query), usersRepo.staffCounts()]);
    return { items, counts };
  },

  /** Crea el staff y dispara la invitacion para que fije su contrasena. */
  async create(input: CreateStaffInput) {
    // Unicidad de email en TODA la poblacion (customer + staff), docs/roles.md §1.3.3.
    const existing = await authRepo.findUserByEmail(input.email);
    if (existing) throw AuthErrors.emailInUse();

    // Hash placeholder inutilizable: bloquea el login hasta aceptar la invitacion.
    // El admin nunca conoce ni digita la contrasena (docs/roles.md §1.3.4).
    const placeholderHash = await hash(randomBytes(32).toString('hex'));
    const user = await usersRepo.insertStaff({
      email: input.email,
      passwordHash: placeholderHash,
      principal: Principal.Staff,
      role: input.role,
      name: input.name,
      phone: input.phone ?? null,
      status: UserStatus.Activo,
    });

    // En dev devolvemos el enlace de invitacion para mostrarlo en la UI (sin SMTP).
    // En prod issueInvitation devuelve null: el token solo viaja por correo.
    const inviteLink = await authService.issueInvitation(user.id, user.email);
    return { ...user, inviteLink: inviteLink ?? undefined };
  },

  /** Edita nombre/telefono/rol/estado con la salvaguarda del ultimo admin. */
  async update(id: string, patch: UpdateStaffInput) {
    const target = await usersRepo.findStaffById(id);
    if (!target) throw UserErrors.notFound();

    const disabling = patch.status === UserStatus.Inactivo;
    const demoting = patch.role !== undefined && patch.role !== Role.Admin;
    const targetIsActiveAdmin = target.role === Role.Admin && target.status === UserStatus.Activo;
    if (targetIsActiveAdmin && (disabling || demoting) && (await usersRepo.countActiveAdmins()) <= 1) {
      throw UserErrors.lastAdmin();
    }

    const updated = await usersRepo.updateStaff(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
    if (!updated) throw UserErrors.notFound();

    // Revocacion inmediata de sesion al deshabilitar (docs/roles.md §1.3.8).
    if (disabling) await authRepo.deleteSessionsByUser(id);
    return updated;
  },
};
