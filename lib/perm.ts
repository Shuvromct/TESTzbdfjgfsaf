import { one } from './db';

/**
 * Who may see and change what.
 * ---------------------------------------------------------------------------
 * Twelve sections, three levels each:
 *
 *   none   the section is not in their navigation and the server will not
 *          serve its records
 *   read   they can open it and read it
 *   edit   they can change the records in it that are theirs — the task they
 *          are responsible for, the verification they were named for, the
 *          decision they are the authority on
 *
 * Then one flag per role, separate from the sections:
 *
 *   keeper  they may act on records that are not their own — reassign a task,
 *           correct somebody else's figure, open the site lock
 *
 * The flag is deliberately not a fourth level. "Edit" means your own work.
 * Acting on another person's record is a different kind of authority, it
 * applies across every section at once, and the project office needs to be
 * able to see at a glance which roles have it.
 *
 * What no permission can ever do
 * ------------------------------
 * The separation of duties is not a permission. Nobody verifies their own
 * work and nobody approves it either, whatever their role says — the rule is
 * enforced in writableTask() and again by check constraints in the table, so
 * a mistake here cannot reach the record.
 */

export const LEVELS = ['none', 'read', 'edit'] as const;
export type Level = typeof LEVELS[number];

export const SECTIONS = [
  { key: 'tasks',      name: 'Task register',     note: 'Tasks, Timeline and the responsibility matrix' },
  { key: 'photos',     name: 'Photographs',       note: 'Site evidence on a task' },
  { key: 'budget',     name: 'Budget',            note: 'Quantities, rates and payments' },
  { key: 'approvals',  name: 'Decisions',         note: 'The approval chain' },
  { key: 'milestones', name: 'Gates',             note: 'Dated milestones' },
  { key: 'survey',     name: 'Zones',             note: 'The site survey' },
  { key: 'students',   name: 'Student teams',     note: 'Teams, supervisors and hours' },
  { key: 'reports',    name: 'Dashboard',         note: 'Roll-ups and the department plan' },
  { key: 'reference',  name: "Chairman's tracker", note: 'The original, read only for everyone' },
  { key: 'activity',   name: 'Log',               note: 'The audit trail' },
  { key: 'users',      name: 'People',            note: 'Accounts and their details' },
  { key: 'admin',      name: 'Administration',    note: 'Roles, the recycle bin, clearing data' },
] as const;

export type SectionKey = typeof SECTIONS[number]['key'];
export const SECTION_KEYS = SECTIONS.map(s => s.key) as SectionKey[];

export type Perms = Partial<Record<SectionKey, Level>>;
export type RoleDef = {
  key: string; name: string; keeper: boolean; superApprove?: boolean; perms: Perms;
};

/**
 * More than one role at a time.
 * ---------------------------------------------------------------------------
 * A person holds a list of roles, and the list is carried through the
 * application as one string with plus signs in it — ADMIN+SUPER_APPROVE. Every
 * existing caller asks `levelOf(me.role, 'budget')` and goes on asking exactly
 * that; roleDef() below is the single place that knows the string may name
 * several roles, and merges them.
 *
 * Merging is the generous reading in every case: the highest level wins each
 * section, and a flag set by any one role is set. Holding a second role can
 * therefore never take something away, which is the only behaviour that is not
 * a trap for whoever assigns them.
 */
export const rolesOf = (key: string): string[] =>
  String(key || '').split('+').map(s => s.trim()).filter(Boolean);

export const roleKey = (list: string[]): string =>
  [...new Set(list.map(s => String(s || '').trim()).filter(Boolean))].join('+');

export const hasRole = (key: string, want: string) => rolesOf(key).includes(want);

const RANK: Record<string, number> = { none: 0, read: 1, edit: 2 };

const all = (level: Level): Perms =>
  Object.fromEntries(SECTION_KEYS.map(k => [k, level])) as Perms;

/** The six the project started with, now written in the new terms. */
export const BUILTIN: Record<string, RoleDef> = {
  ADMIN: {
    key: 'ADMIN', name: 'Administrator', keeper: true, perms: all('edit'),
  },
  DIRECTOR: {
    key: 'DIRECTOR', name: 'Project Director', keeper: true,
    perms: { ...all('edit'), admin: 'none', activity: 'read', reference: 'read' },
  },
  APPROVER: {
    key: 'APPROVER', name: 'Approval Authority', keeper: false,
    perms: { tasks: 'read', photos: 'read', budget: 'read', approvals: 'edit',
             milestones: 'read', survey: 'none', students: 'none', reports: 'read',
             reference: 'read', activity: 'read', users: 'none', admin: 'none' },
  },
  DEPT_HEAD: {
    key: 'DEPT_HEAD', name: 'Department Head', keeper: false,
    perms: { tasks: 'edit', photos: 'edit', budget: 'edit', approvals: 'read',
             milestones: 'read', survey: 'read', students: 'read', reports: 'read',
             reference: 'read', activity: 'read', users: 'none', admin: 'none' },
  },
  MEMBER: {
    key: 'MEMBER', name: 'Responsible Person', keeper: false,
    perms: { tasks: 'edit', photos: 'edit', budget: 'none', approvals: 'read',
             milestones: 'read', survey: 'read', students: 'none', reports: 'none',
             reference: 'read', activity: 'none', users: 'none', admin: 'none' },
  },
  VIEWER: {
    key: 'VIEWER', name: 'Observer', keeper: false,
    perms: { ...all('read'), users: 'none', admin: 'none', activity: 'none' },
  },
  /**
   * Super approve — a second role, not a bigger first one.
   *
   * It carries no sections of its own: given to somebody on its own it opens
   * nothing. Its whole content is the flag, and the flag does one thing —
   * record a verification or an approval on behalf of the person the item is
   * waiting on, including on work that person is themselves responsible for.
   *
   * Which is not the same as signing off your own work, and deliberately so.
   * The record still says the named verifier verified it; a second line says
   * who pressed the button and that they did it on that person's behalf. The
   * check constraints in the table are untouched and still refuse to write
   * one person into two chairs.
   */
  SUPER_APPROVE: {
    key: 'SUPER_APPROVE', name: 'Super approve', keeper: false, superApprove: true,
    perms: all('none'),
  },
};

/** The administrator's own role is never editable: it is the way back in. */
export const LOCKED = ['ADMIN'];

/* ----------------------------------------------------------------- store */
/* Every role, built-in or not, is kept in settings under 'perms'. A
   built-in that has not been edited is served from the table above, so a
   fresh database behaves exactly as it always did. */

type Stored = { roles?: RoleDef[] };

export async function storedRoles(): Promise<RoleDef[]> {
  try {
    const row = await one(`select value from settings where key='perms'`);
    const v: Stored = (row && row.value) || {};
    return Array.isArray(v.roles) ? v.roles.filter(r => r && r.key) : [];
  } catch { return []; }
}

/** Every role the system knows, edits applied over the built-in defaults. */
export async function allRoles(): Promise<RoleDef[]> {
  const stored = await storedRoles();
  const byKey = new Map(stored.map(r => [r.key, r]));
  const out: RoleDef[] = [];

  for (const k of Object.keys(BUILTIN)) {
    const edited = byKey.get(k);
    out.push(LOCKED.includes(k) ? BUILTIN[k] : { ...BUILTIN[k], ...(edited || {}), key: k });
    byKey.delete(k);
  }
  for (const r of byKey.values()) out.push(clean(r));
  return out;
}

export async function roleDef(key: string): Promise<RoleDef> {
  const want = rolesOf(key);
  const every = await allRoles();
  const held = want.map(k => every.find(r => r.key === k)).filter(Boolean) as RoleDef[];

  if (!held.length) return { key, name: key, keeper: false, perms: all('none') };
  if (held.length === 1) return held[0];

  /* Several roles at once: the best of each. */
  const perms = all('none');
  for (const k of SECTION_KEYS) {
    let best = 'none' as Level;
    for (const r of held) {
      const lv = (r.perms[k] || 'none') as Level;
      if (RANK[lv] > RANK[best]) best = lv;
    }
    perms[k] = best;
  }
  return {
    key: roleKey(held.map(r => r.key)),
    name: held.map(r => r.name).join(' + '),
    keeper: held.some(r => r.keeper),
    superApprove: held.some(r => r.superApprove),
    perms,
  };
}

/** What this role may do in this section. */
export async function levelOf(role: string, section: SectionKey): Promise<Level> {
  const d = await roleDef(role);
  const lv = d.perms[section];
  return (LEVELS as readonly string[]).includes(lv as string) ? (lv as Level) : 'none';
}

export const canRead = async (role: string, s: SectionKey) => (await levelOf(role, s)) !== 'none';
export const canEdit = async (role: string, s: SectionKey) => (await levelOf(role, s)) === 'edit';

/** May this role act on records that are not its own? */
export async function isKeeper(role: string): Promise<boolean> {
  return !!(await roleDef(role)).keeper;
}

/**
 * May this role sign off on somebody else's behalf?
 *
 * Separate from keeper, which is about correcting other people's records. This
 * is about the two decisions the project exists to keep honest, so it is its
 * own flag and the Roles page shows it in its own column.
 */
export async function isSuper(role: string): Promise<boolean> {
  return !!(await roleDef(role)).superApprove;
}

/** The sections this role may open, for the navigation. */
export async function readableSections(role: string): Promise<SectionKey[]> {
  const d = await roleDef(role);
  return SECTION_KEYS.filter(k => (d.perms[k] || 'none') !== 'none');
}

/** Scrub anything a client sent that is not part of the shape. */
export function clean(r: any): RoleDef {
  const perms: Perms = {};
  for (const k of SECTION_KEYS) {
    const v = r && r.perms ? r.perms[k] : undefined;
    perms[k] = (LEVELS as readonly string[]).includes(v) ? v : 'none';
  }
  return {
    key: String(r.key || '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 24),
    name: String(r.name || r.key || '').slice(0, 60),
    keeper: !!(r && r.keeper),
    superApprove: !!(r && r.superApprove),
    perms,
  };
}
