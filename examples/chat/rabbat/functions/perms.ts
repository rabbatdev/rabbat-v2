// Orbit permissions — a small bitfield. The owner implicitly has every
// permission; everyone can always send messages and edit/delete their own.

export const Perm = {
  MANAGE_ORBIT: 1, // rename/delete the orbit
  MANAGE_CHANNELS: 2, // create/edit/delete channels & categories
  MANAGE_MESSAGES: 4, // delete anyone's messages
  MANAGE_ROLES: 8, // change members' roles
  KICK_MEMBERS: 16, // remove members
  CREATE_INVITE: 32, // create / manage invite links
  MANAGE_EMOJI: 64, // create / delete custom emoji (owner-only by default)
} as const;

export type PermFlag = (typeof Perm)[keyof typeof Perm];

export const ALL_PERMS =
  Perm.MANAGE_ORBIT |
  Perm.MANAGE_CHANNELS |
  Perm.MANAGE_MESSAGES |
  Perm.MANAGE_ROLES |
  Perm.KICK_MEMBERS |
  Perm.CREATE_INVITE |
  Perm.MANAGE_EMOJI;

/** Roles auto-created with every orbit. The owner isn't a role — it's tracked by
 *  `orbit.owner_id` and short-circuits every permission check. */
export const DEFAULT_ROLES = [
  {
    name: "Admin",
    permissions: Perm.MANAGE_CHANNELS | Perm.MANAGE_MESSAGES | Perm.KICK_MEMBERS | Perm.CREATE_INVITE,
    position: 1,
    color: "210",
  },
  { name: "Member", permissions: 0, position: 2, color: null as string | null },
] as const;

export const DEFAULT_ROLE_NAME = "Member";

export interface OrbitCtx {
  orbitId: string;
  userId: string;
  isMember: boolean;
  isOwner: boolean;
  roleId: string | null;
  permissions: number;
}

/** Resolve a user's standing in an orbit: membership, ownership, effective perms.
 *  `db` is `ctx.db` (typed loosely here to stay reusable across query/mutation). */
export async function orbitContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  orbitId: string,
  userId: string,
): Promise<OrbitCtx> {
  const orbit = await db.get("orbits", orbitId);
  if (!orbit) throw new Error("orbit not found");
  const member = await db.table("members").where({ orbit_id: orbitId, user_id: userId }).first();
  const isOwner = orbit.owner_id === userId;
  let permissions = 0;
  if (isOwner) {
    permissions = ALL_PERMS;
  } else if (member) {
    const role = await db.get("roles", member.role_id);
    permissions = role?.permissions ?? 0;
  }
  return {
    orbitId,
    userId,
    isMember: isOwner || !!member,
    isOwner,
    roleId: member?.role_id ?? null,
    permissions,
  };
}

export function can(octx: OrbitCtx, perm: number): boolean {
  return octx.isOwner || (octx.permissions & perm) !== 0;
}

/** Parse a channel's comma-joined role-id override into a set ("" / null = none). */
export function parseRoleSet(value: string | null | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
}

type ChannelPerms = { view_roles?: string | null; send_roles?: string | null };

/** Who can SEE a channel: the owner and channel managers always; otherwise
 *  everyone when no override is set, else only the listed roles. */
export function canViewChannel(channel: ChannelPerms, octx: OrbitCtx): boolean {
  if (octx.isOwner || can(octx, Perm.MANAGE_CHANNELS)) return true;
  const allowed = parseRoleSet(channel.view_roles);
  return allowed.size === 0 || (octx.roleId != null && allowed.has(octx.roleId));
}

/** Who can POST in a channel: the owner always; otherwise everyone when no
 *  override is set, else only the listed roles (e.g. an announcement channel). */
export function canSendInChannel(channel: ChannelPerms, octx: OrbitCtx): boolean {
  if (octx.isOwner) return true;
  const allowed = parseRoleSet(channel.send_roles);
  return allowed.size === 0 || (octx.roleId != null && allowed.has(octx.roleId));
}

/** Throw unless the user is a member with the given permission. */
export function requirePerm(octx: OrbitCtx, perm: number, message: string): void {
  if (!octx.isMember) throw new Error("you are not a member of this orbit");
  if (!can(octx, perm)) throw new Error(message);
}
