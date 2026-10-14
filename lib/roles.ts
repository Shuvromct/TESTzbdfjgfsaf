/**
 * Roles, as the rest of the application asks about them.
 *
 * The definitions live in lib/perm.ts now: twelve sections, three levels, and
 * one keeper flag per role. This file is what the route handlers import.
 *
 * `isKeeper` used to live here and was synchronous. Reading a role now means
 * reading the stored permissions, which is a database call, so the answer is
 * a promise — and `if (isKeeper(role))` on a promise is true for everybody.
 * Rather than leave a trap of that shape in nine route handlers, the name is
 * gone. Anything that still asks for it fails to compile.
 */
export {
  SECTIONS, SECTION_KEYS, LEVELS, BUILTIN, LOCKED,
  allRoles, roleDef, levelOf, canRead, canEdit, readableSections, clean,
  rolesOf, roleKey, hasRole, isSuper,
} from './perm';
export type { Level, SectionKey, Perms, RoleDef } from './perm';

import { isKeeper, canEdit, canRead, allRoles, roleKey as roleKeyOf } from './perm';
import type { SectionKey } from './perm';

/** May this role act on records that are not its own? Await it. */
export const mayManage = isKeeper;

/** May this role change things in this section at all? Await it. */
export async function mayUse(role: string, section: SectionKey): Promise<boolean> {
  return canEdit(role, section);
}

/** May this role so much as open this section? Await it. */
export async function maySee(role: string, section: SectionKey): Promise<boolean> {
  return canRead(role, section);
}

export async function knownRoles(): Promise<string[]> {
  return (await allRoles()).map(r => r.key);
}

/**
 * The roles a user row holds.
 *
 * `roles` is the list and `role` is the first of it. A row written before the
 * array existed — or by anything that still only knows about the column — has
 * an empty list, so the column is the fallback rather than an error.
 */
export function heldRoles(u: { role?: string | null; roles?: string[] | null }): string[] {
  const list = Array.isArray(u?.roles) && u.roles.length ? u.roles : (u?.role ? [u.role] : []);
  return [...new Set(list.map(String).filter(Boolean))];
}

/** What goes in the session cookie: every role the person holds, as one key. */
export function sessionRole(u: { role?: string | null; roles?: string[] | null }): string {
  return roleKeyOf(heldRoles(u)) || 'VIEWER';
}

/** Kept for the client payload: every role, with what it may reach. */
export async function rolesForClient() {
  return (await allRoles()).map(r => ({
    key: r.key, name: r.name, keeper: r.keeper, superApprove: !!r.superApprove, perms: r.perms,
  }));
}
