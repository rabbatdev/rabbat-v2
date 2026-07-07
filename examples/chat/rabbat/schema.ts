// The "en" schema — defined in TypeScript, the single source of truth.
//
// `pnpm codegen` turns this into:
//   • rabbat.schema.json        → loaded by the Rust server
//   • functions/_generated/...  → the type-safe `api`
// and `DataModelOf<typeof schema>` types `ctx.db` in every function.
//
// Model: a user belongs to one or more **orbits** (servers). Each orbit has
// roles (a permission bitfield), members (a user + role), categories, and
// channels; messages live in channels. Read-state powers unread badges and
// presence powers accurate online status.

import { defineSchema, defineTable, s } from "@rabbat/schema";

export const schema = defineSchema({
  // ── Orbits (servers) ──────────────────────────────────────────────────────
  orbits: defineTable({
    id: s.text().primaryKey(),
    name: s.text(),
    // Shareable invite code (unique). Null = invites paused: no one new can join.
    invite: s.text().unique().nullable(),
    // Accent hue 0–360 — the fallback identity colour when there's no icon.
    hue: s.int(),
    // Uploaded server icon + cover banner (UploadThing URLs), nullable.
    icon: s.text().nullable(),
    cover: s.text().nullable(),
    owner_id: s.text().index(),
    created_at: s.int().index(),
  }),

  // A role within an orbit. `permissions` is a bitfield (see functions/perms.ts).
  roles: defineTable({
    id: s.text().primaryKey(),
    orbit_id: s.text().index(),
    name: s.text(),
    permissions: s.int(),
    // Display colour (hue string) for the role.
    color: s.text().nullable(),
    // Lower = higher in the list / more senior.
    position: s.int(),
    created_at: s.int(),
  }),

  // A shareable invite link. The id IS the code (used in /invite/<code>).
  // `expires_at` (ms) and `max_uses` are both nullable = no limit.
  invites: defineTable({
    id: s.text().primaryKey(),
    orbit_id: s.text().index(),
    creator_id: s.text(),
    expires_at: s.int().nullable(),
    max_uses: s.int().nullable(),
    uses: s.int(),
    created_at: s.int(),
  }),

  // Orbit membership: one row per (user, orbit), carrying the user's role.
  members: defineTable({
    id: s.text().primaryKey(),
    orbit_id: s.text().index(),
    user_id: s.text().index(),
    role_id: s.text(),
    joined_at: s.int().index(),
  }),

  // A channel grouping inside an orbit.
  categories: defineTable({
    id: s.text().primaryKey(),
    orbit_id: s.text().index(),
    name: s.text(),
    position: s.int(),
  }),

  channels: defineTable({
    id: s.text().primaryKey(),
    orbit_id: s.text().index(),
    category_id: s.text().nullable(),
    name: s.text(),
    topic: s.text().nullable(),
    position: s.int(),
    created_at: s.int().index(),
    // Channel permission overrides: comma-joined role IDs allowed to view / send.
    // Null/empty = everyone (the default). Appended last so existing channel
    // rows stay valid (read as null → no restriction).
    view_roles: s.text().nullable(),
    send_roles: s.text().nullable(),
  }),

  messages: defineTable(
    {
      id: s.text().primaryKey(),
      channel_id: s.text().index(),
      // The author's user id (resolved to a profile for display).
      author_id: s.text().index(),
      body: s.text(),
      edited: s.bool().nullable(),
      reply_to: s.text().nullable(),
      created_at: s.int().index(),
      // Uploaded media (image/video) attached to the message: a JSON array of
      // `{ url, kind, w, h, name?, size? }`. Appended last (nullable) so existing
      // rows read as null. Capped at 5 MB/file in the upload route.
      attachments: s.text().nullable(),
      // Link unfurls computed out-of-band by the embeds.unfurl action: a JSON
      // array of `{ type, url, ... }` (generic OG card, direct media, or an X/
      // Twitter post with its full photo gallery). Appended last (nullable).
      embeds: s.text().nullable(),
    },
    {
      // The hot path: a channel's messages oldest→newest. Stored as
      // `(channel_id, created_at, id)`, so `where channel_id = X order by
      // created_at` is an index seek — O(log n + page), not a channel scan+sort.
      indexes: [["channel_id", "created_at"]],
    },
  ),

  // Custom emoji: orbit-scoped uploaded images, written into message bodies as
  // `:name:` and usable as reactions. `name` is unique within an orbit (enforced
  // in the mutation). Creating them needs MANAGE_EMOJI (owner-only by default).
  custom_emoji: defineTable({
    id: s.text().primaryKey(),
    orbit_id: s.text().index(),
    name: s.text(), // [a-z0-9_]{2,32}, unique per orbit
    url: s.text(), // UploadThing image URL
    creator_id: s.text(),
    created_at: s.int().index(),
  }),

  // A reaction: one row per (user, message, emoji). `emoji` holds either a
  // unicode grapheme (e.g. "🔥") or "custom:<emojiId>" for an orbit custom emoji.
  reactions: defineTable({
    id: s.text().primaryKey(),
    message_id: s.text().index(),
    channel_id: s.text().index(),
    user_id: s.text().index(),
    emoji: s.text(),
    created_at: s.int().index(),
  }),

  // Per-user, per-channel read marker → drives unread badges.
  read_state: defineTable({
    id: s.text().primaryKey(),
    user_id: s.text().index(),
    channel_id: s.text().index(),
    last_read_at: s.int(),
  }),

  // Presence heartbeat → accurate online status (online if last_seen is recent).
  presence: defineTable({
    user_id: s.text().primaryKey(),
    last_seen: s.int(),
    // "online" | "idle" | "dnd"
    status: s.text(),
  }),

  // Inbox: a row per time a user is mentioned or replied to. Drives the
  // notification popover; each links straight to the message.
  notifications: defineTable({
    id: s.text().primaryKey(),
    user_id: s.text().index(), // recipient
    actor_id: s.text(), // who mentioned/replied
    kind: s.text(), // "mention" | "reply"
    orbit_id: s.text(),
    channel_id: s.text(),
    message_id: s.text(),
    snippet: s.text(), // short preview of the message
    read: s.bool().nullable(), // null/false = unread
    created_at: s.int().index(),
  }),

  // Web Push subscriptions — one row per (user, browser/device endpoint). Lets
  // the server deliver notifications when the app's tab is closed. `endpoint` is
  // the push-service URL (unique); `p256dh`/`auth` are the subscription keys.
  push_subscriptions: defineTable({
    id: s.text().primaryKey(),
    user_id: s.text().index(),
    endpoint: s.text().unique(),
    p256dh: s.text(),
    auth: s.text(),
    ua: s.text().nullable(), // user-agent, for the "your devices" list
    created_at: s.int().index(),
  }),

  // ── Better Auth tables (field names match its core schema) ─────────────────
  // `bio` and `accent` are profile extras (Better Auth additionalFields).
  user: defineTable({
    id: s.text().primaryKey(),
    // `name` is the (non-unique) display name; `username` is the unique handle.
    name: s.text(),
    email: s.text().unique(),
    emailVerified: s.bool(),
    image: s.text().nullable(),
    // Profile cover banner (UploadThing URL).
    cover: s.text().nullable(),
    bio: s.text().nullable(),
    accent: s.text().nullable(),
    createdAt: s.text(),
    updatedAt: s.text(),
    // Discord-style unique @handle. Appended last (backward-compatible) and
    // nullable so existing users + Better Auth's inserts read it as null until
    // the user picks one.
    username: s.text().unique().nullable(),
  }),
  session: defineTable({
    id: s.text().primaryKey(),
    expiresAt: s.text(),
    token: s.text().unique(),
    createdAt: s.text(),
    updatedAt: s.text(),
    ipAddress: s.text().nullable(),
    userAgent: s.text().nullable(),
    userId: s.text().index(),
  }),
  account: defineTable(
    {
      id: s.text().primaryKey(),
      accountId: s.text(),
      providerId: s.text(),
      userId: s.text().index(),
      accessToken: s.text().nullable(),
      refreshToken: s.text().nullable(),
      idToken: s.text().nullable(),
      accessTokenExpiresAt: s.text().nullable(),
      refreshTokenExpiresAt: s.text().nullable(),
      scope: s.text().nullable(),
      password: s.text().nullable(),
      createdAt: s.text(),
      updatedAt: s.text(),
    },
    {
      // Better Auth's OAuth account lookup — `where accountId = X and
      // providerId = Y` (findOAuthUser / findAccountByProviderId) — would
      // full-scan (rejected under --reject-unindexed). A composite index (not a
      // bare `.index()`) so it's backfilled over existing rows when the server
      // opens the DB: a single-column index added to an already-populated table
      // starts empty, so returning users' accounts wouldn't be seek-visible.
      indexes: [["accountId", "providerId"]],
    },
  ),
  verification: defineTable({
    id: s.text().primaryKey(),
    identifier: s.text().index(),
    value: s.text(),
    // Indexed for Better Auth's expired-row sweep — `deleteMany(verification
    // where expiresAt < now)` runs after every verification lookup and would
    // otherwise full-scan (rejected under --reject-unindexed), surfacing as a
    // "Failed to parse state" error on OAuth callback.
    expiresAt: s.text().index(),
    createdAt: s.text(),
    updatedAt: s.text(),
  }),
});

export default schema;
