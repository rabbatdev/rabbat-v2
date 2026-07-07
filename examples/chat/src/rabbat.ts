// The type-safe api tree + the app's shared types for "en". The FunctionsClient
// itself is created and provided by the Rabbat framework (entry-client →
// RabbatProvider); components read it via the @rabbat/react hooks (useQuery,
// useMutation, …).
//
// Row<…> names a raw table row; FunctionReturns<typeof api.x> names a query's
// result. Deriving the view types here means components never re-declare an
// interface or cast `useQuery(...)` — they `import type { Member } from "@/rabbat"`.

import type { FunctionReturns } from "@rabbat/react";
import type { Row } from "@rabbat/schema";

import { api } from "../rabbat/_generated/api.ts";
import { schema } from "../rabbat/schema";

export { api };

// ── raw table rows ──────────────────────────────────────────────────────────
export type Orbit = Row<typeof schema, "orbits">;
export type Category = Row<typeof schema, "categories">;
export type Channel = Row<typeof schema, "channels">;
export type Message = Row<typeof schema, "messages">;

// ── query result shapes (derived — the single source of truth is the handler) ─
/** An orbit plus the current user's membership (`isOwner`/`permissions`/`roleId`). */
export type OrbitDetail = NonNullable<FunctionReturns<typeof api.orbits.get>>;
/** A public invite preview (orbit name, icon, member count). */
export type InvitePreview = NonNullable<FunctionReturns<typeof api.orbits.byInvite>>;
/** An orbit member enriched with profile, role, and live presence. */
export type Member = FunctionReturns<typeof api.members.list>[number];
/** A role row (name, permissions bitfield, colour, position). */
export type Role = FunctionReturns<typeof api.roles.list>[number];
/** The signed-in user's editable profile. */
export type Profile = NonNullable<FunctionReturns<typeof api.profile.me>>;
/** A live invite link for an orbit. */
export type Invite = FunctionReturns<typeof api.invites.list>[number];
/** A custom emoji belonging to an orbit. */
export type CustomEmoji = FunctionReturns<typeof api.emoji.list>[number];
/** A custom emoji usable by the current user (across their orbits). */
export type AvailableEmoji = FunctionReturns<typeof api.emoji.available>[number];
/** Per-channel unread state, keyed by channel id. */
export type UnreadMap = FunctionReturns<typeof api.readState.unread>;
