// Client mirror of functions/perms.ts — for showing/hiding UI affordances.
// The server is always the source of truth and re-checks every mutation.

export const Perm = {
  MANAGE_ORBIT: 1,
  MANAGE_CHANNELS: 2,
  MANAGE_MESSAGES: 4,
  MANAGE_ROLES: 8,
  KICK_MEMBERS: 16,
  CREATE_INVITE: 32,
  MANAGE_EMOJI: 64,
} as const;

export interface OrbitWithPerms {
  isOwner?: boolean;
  permissions?: number;
}

export function hasPerm(orbit: OrbitWithPerms | null | undefined, flag: number): boolean {
  if (!orbit) return false;
  return !!orbit.isOwner || ((orbit.permissions ?? 0) & flag) !== 0;
}
