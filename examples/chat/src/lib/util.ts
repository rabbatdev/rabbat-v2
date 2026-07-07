const ADJECTIVES = ["ink", "vermilion", "paper", "neon", "quiet", "amber", "cobalt", "riso", "matte", "stark"];
const NOUNS = ["otter", "finch", "comet", "press", "ember", "fox", "kite", "moth", "reef", "vane"];

/** Message text from a caught `unknown` — honest about the fact that a thrown
 *  value isn't guaranteed to be an `Error` (avoids the `(err as Error).message`
 *  cast, which silently yields `undefined` for a non-Error throw). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

/** A friendly default handle, e.g. "ink-fox-42". */
export function randomHandle(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}-${n}-${Math.floor(Math.random() * 90 + 10)}`;
}

/** Stable hue (0–360) derived from a string — for per-author accent colors. */
export function hueOf(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) % 360;
  return h;
}

/** A muted, two-stop gradient avatar fill — distinguishable per person but
 *  low-chroma and tasteful, the way Linear tints initials (never candy-bright). */
export function avatarBg(name: string): string {
  const h = hueOf(name);
  return `linear-gradient(145deg, oklch(0.6 0.072 ${h}), oklch(0.47 0.082 ${(h + 26) % 360}))`;
}

/** A vivid two-stop gradient from a chosen accent hue (the brand violet by
 *  default) — for profile banners, owned avatars, accent chips. */
export function accentColor(accent: string | null | undefined): string {
  const h = accent != null && accent !== "" ? Number(accent) : 300;
  const hue = Number.isFinite(h) ? h : 300;
  return `linear-gradient(140deg, oklch(0.64 0.18 ${hue}), oklch(0.58 0.17 ${(hue + 30) % 360}))`;
}

/** A user's display fill: their chosen accent if set, else a muted hash of their
 *  name. Used for avatars that lack a photo. */
export function userColor(accent: string | null | undefined, name: string): string {
  return accent ? accentColor(accent) : avatarBg(name);
}

/** A role's display tint from its stored hue (e.g. "210"). Bright enough to read
 *  as a colored name on the dark surfaces; undefined when the role has no color. */
export function roleTint(color: string | null | undefined): string | undefined {
  if (color == null || color === "") return undefined;
  const h = Number(color);
  if (!Number.isFinite(h)) return undefined;
  return `oklch(0.78 0.15 ${h})`;
}

/** Presentation for a presence status: a label and a dot colour. "invisible" is
 *  only ever shown to the user themselves (others see them as "offline"). */
export function statusMeta(status: string | null | undefined): {
  label: string;
  color: string;
  hollow: boolean;
} {
  switch (status) {
    case "online":
      return { label: "Online", color: "var(--success)", hollow: false };
    case "busy":
      return { label: "Busy", color: "var(--destructive)", hollow: false };
    case "invisible":
      return { label: "Invisible", color: "var(--muted-foreground)", hollow: true };
    default:
      return { label: "Offline", color: "var(--muted-foreground)", hollow: true };
  }
}

export function initials(name: string): string {
  const parts = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(" ");
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Collapse a markdown message body to a one-line plain-text preview — for
 *  reply quotes, the composer reply banner, and notification snippets. Mentions
 *  become `@name`, custom emoji `:name:`, other links their text, and markdown
 *  punctuation is stripped. */
export function bodyPreview(body: string): string {
  return body
    .replace(/\[@([^\]]+)\]\(mention:[^)\s]+\)/g, "@$1")
    .replace(/\[:([^\]]+):\]\(emoji:[^)\s]+\)/g, ":$1:")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
