# en (example)

**en** is a real-time community app — think Discord-shaped, Linear-flavoured —
on the full Rabbat stack: **React + Vite 8 + shadcn/ui + TanStack Router** →
**TypeScript functions server** → **Rabbat (Rust)**.

Shows off:

- **Orbits** — servers you create or join (by invite code). They live on the
  vertical rail at the far left; you must be in one to use the app.
- **Roles & permissions** — every orbit has one owner plus a permission bitfield
  (`functions/perms.ts`: `MANAGE_CHANNELS`, `MANAGE_MESSAGES`, `MANAGE_ROLES`,
  `KICK_MEMBERS`). Creating channels, deleting others' messages, assigning roles
  and kicking are all gated, server-side, on the caller's permissions.
- **Categories** — channels are grouped under collapsible categories.
- **Unread** — a reactive per-user/per-channel read model lights up unread
  channels with a dot; opening one marks it read.
- **Presence** — a heartbeat mutation keeps online status honest (a member is
  offline 45s after their last beat), shown live in the members rail.
- **Profiles** — Google avatar, bio, and a chosen accent colour; click any
  member for a profile card (with role/kick actions if you're allowed).
- **Confirmations** — destructive actions (delete message/channel, leave/delete
  orbit, kick) go through a confirm dialog.
- **Google-only auth** via Better Auth. The `user`/`session`/`account`/
  `verification` tables live in Rabbat through a custom adapter
  (`functions/auth-adapter.ts`) over the imperative `RabbatClient`. Sign-in is a
  same-origin cookie session that rides the WS upgrade (proxied `/fns`), so every
  query/mutation runs as the signed-in user. (Set `DEV_EMAIL_AUTH=1` to enable a
  hidden email path for local e2e, since Google's OAuth can't run headless.)
- **Live sync, anchored pagination, replies, jump-to-message** — messages,
  channels, roles and presence update instantly; the live tail pages both ways
  and "jump to a quoted message" re-anchors the window around it.

## Run it

Four steps (from the repo root):

```bash
pnpm install
pnpm codegen          # schema.ts -> rabbat.schema.json + functions/_generated/api.ts
pnpm dev:db           # Rabbat           ws://localhost:3652/ws
pnpm dev:functions    # functions + auth  ws://localhost:3651, http://localhost:3654/api/auth
pnpm dev:chat         # this app          http://localhost:3650  (proxies /api/auth → :3654)
```

Ports live in an uncommon `365x` block (`3650` app · `3651` functions · `3652`
db · `3653` optional replica · `3654` Better Auth) so the stack never clashes
with other dev servers. Open the app and **sign up** (email + password) to get in.

Then seed a lot of data so pagination/replies are fun to test (DB must be up):

```bash
pnpm --filter en seed                       # ~800 messages/channel
MESSAGES_PER_CHANNEL=3000 pnpm --filter en seed
```

## Layout

| Path | Highlights |
| --- | --- |
| `schema.ts` | The schema in TypeScript (incl. `reply_to`) — the single source of truth. |
| `functions/messages.ts` | `list` (paginated), `get` (reply preview / jump), `send` (with `replyTo`), `edit`, `remove`. |
| `functions/server.ts` | The functions server (`serveApp`) with `auth` + middleware. |
| `seed.ts` | Bulk-loads channels + thousands of messages (~15% replies) via Rabbat HTTP. |
| `src/router.tsx` | TanStack Router routes — `/c/$channelId` and the `?at=` jump anchor. |
| `src/components/MessageList.tsx` | Bi-directional anchored scroll, reply previews, URL-driven jump-to-message. |
| `src/components/ui/` | shadcn/ui primitives (button, input, scroll-area, avatar, tooltip…). |
| `functions-test.ts` / `e2e.mjs` | Functions-layer + real-browser tests. |
