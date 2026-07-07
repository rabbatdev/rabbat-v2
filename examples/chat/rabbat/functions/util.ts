/** A short, collision-resistant id for `text @pk` columns. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// Unambiguous code alphabet (no 0/O/1/I) for shareable invite links.
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A random 8-char invite code. */
export function newInviteCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  return s;
}

/** An invite is live if it hasn't expired and hasn't hit its max uses. */
export function isInviteLive(
  inv: { expires_at: number | null; max_uses: number | null; uses: number },
  now: number,
): boolean {
  if (inv.expires_at != null && inv.expires_at <= now) return false;
  if (inv.max_uses != null && inv.uses >= inv.max_uses) return false;
  return true;
}
