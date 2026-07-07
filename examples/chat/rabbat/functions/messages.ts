// Message queries & mutations. These run on the functions server, not the
// browser — so they can trust `ctx.identity` and enforce orbit permissions.

import { paginationOpts, v } from "rabbat/functions";

import { mutation, query, publicQuery, type DataModel } from "./setup.ts";
import { newId } from "./util.ts";
import { can, canSendInChannel, canViewChannel, orbitContext, Perm } from "./perms.ts";
import { internal } from "../_generated/api.ts";

type UserRow = DataModel["user"]["row"];

/** Live, bi-directional page of a channel's messages (oldest → newest), each
 *  enriched with its author's profile and (if any) its reply parent. Resolving
 *  authors/parents through `ctx.db` makes them reactive dependencies. */
export const list = publicQuery({
  args: { channelId: v.string(), paginationOpts },
  handler: async (ctx, { channelId, paginationOpts }) => {
    // Hide the channel's messages from anyone not allowed to view it. Paginating
    // over a sentinel id keeps the page shape intact while returning nothing.
    const me = ctx.identity;
    const channel = await ctx.db.get("channels", channelId);
    let allowed = !!channel && !!me;
    if (channel && me) {
      const octx = await orbitContext(ctx.db, channel.orbit_id, me.subject);
      allowed = canViewChannel(channel, octx);
    }
    const page = await ctx.db
      .table("messages")
      .where({ channel_id: allowed ? channelId : "no-access" })
      .order("created_at", "asc")
      .paginate(paginationOpts);

    // Enrich with authors and reply-parents using *batched* `in` queries — two
    // subscriptions total — so the live subscription count stays constant no
    // matter how far the window is scrolled (rather than one per author/parent).
    const replyIds = [...new Set(page.page.map((m) => m.reply_to).filter((x): x is string => !!x))];
    const parents = replyIds.length
      ? await ctx.db.table("messages").where("id", "in", replyIds).collect()
      : [];
    const parentById = new Map(parents.map((p) => [p.id, p]));

    // Reactions for the visible page (one batched `in` query → constant
    // subscription). Fetched before users so reactors can be name-resolved in
    // the same `user` batch. Chronological so emoji + reactor order is stable.
    const msgIds = page.page.map((m) => m.id);
    const reactionRows = msgIds.length
      ? await ctx.db.table("reactions").where("message_id", "in", msgIds).collect()
      : [];
    reactionRows.sort((a, b) => a.created_at - b.created_at);

    const authorIds = new Set<string>();
    for (const m of page.page) authorIds.add(m.author_id);
    for (const p of parents) authorIds.add(p.author_id);
    for (const r of reactionRows) authorIds.add(r.user_id); // resolve reactor names too
    const users = authorIds.size
      ? ((await ctx.db.table("user").where("id", "in", [...authorIds]).collect()) as UserRow[])
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    // Aggregate per message → {emoji, count, mine, users[]} grouped, ordered by
    // first use. `mine` highlights the caller's reactions; `users` powers the
    // right-click "who reacted" menu.
    type Agg = { emoji: string; count: number; mine: boolean; first: number; userIds: string[] };
    const reactionsByMsg = new Map<string, Map<string, Agg>>();
    for (const r of reactionRows) {
      let group = reactionsByMsg.get(r.message_id);
      if (!group) reactionsByMsg.set(r.message_id, (group = new Map()));
      const cur = group.get(r.emoji);
      if (cur) {
        cur.count += 1;
        cur.mine ||= r.user_id === me?.subject;
        cur.userIds.push(r.user_id);
      } else {
        group.set(r.emoji, { emoji: r.emoji, count: 1, mine: r.user_id === me?.subject, first: r.created_at, userIds: [r.user_id] });
      }
    }
    const reactionsFor = (id: string) =>
      [...(reactionsByMsg.get(id)?.values() ?? [])]
        .sort((a, b) => a.first - b.first)
        .map(({ emoji, count, mine, userIds }) => ({
          emoji,
          count,
          mine,
          users: userIds.map((uid) => ({ id: uid, name: userById.get(uid)?.name ?? "unknown" })),
        }));

    // Resolve every custom emoji referenced in this page — message bodies
    // (`(emoji:id)`) and `custom:id` reactions — and bundle the {id,name,url}
    // with each message. This is NOT scoped to the viewer's orbits, so emoji
    // posted from a server the viewer isn't in still render; bundling it with
    // the message data means it's present on first paint (no late re-render).
    const refIds = new Set<string>();
    for (const m of page.page) for (const mt of m.body.matchAll(/\(emoji:([^)\s]+)\)/g)) refIds.add(mt[1]);
    for (const r of reactionRows) if (r.emoji.startsWith("custom:")) refIds.add(r.emoji.slice("custom:".length));
    // Fetch exactly the referenced emoji by primary key (point lookups), never a
    // full table scan.
    const emojiById = refIds.size
      ? new Map(
          (await ctx.db.table("custom_emoji").where("id", "in", [...refIds]).collect()).map(
            (e) => [e.id, { id: e.id, name: e.name, url: e.url }] as const,
          ),
        )
      : new Map<string, { id: string; name: string; url: string }>();
    const emojiDefsFor = (m: { body: string; id: string }) => {
      const ids = new Set<string>();
      for (const mt of m.body.matchAll(/\(emoji:([^)\s]+)\)/g)) ids.add(mt[1]);
      for (const r of reactionsFor(m.id)) {
        if (r.emoji.startsWith("custom:")) ids.add(r.emoji.slice("custom:".length));
      }
      return [...ids].map((id) => emojiById.get(id)).filter((e): e is { id: string; name: string; url: string } => !!e);
    };

    const enriched = page.page.map((m) => {
      const author = userById.get(m.author_id);
      let reply_author: string | null = null;
      let reply_body: string | null = null;
      let reply_author_image: string | null = null;
      let reply_author_accent: string | null = null;
      if (m.reply_to) {
        const parent = parentById.get(m.reply_to);
        if (parent) {
          const pa = userById.get(parent.author_id);
          reply_author = pa?.name ?? "unknown";
          reply_author_image = pa?.image ?? null;
          reply_author_accent = pa?.accent ?? null;
          reply_body = parent.body.slice(0, 160);
        }
      }
      return {
        ...m,
        author_name: author?.name ?? "unknown",
        author_image: author?.image ?? null,
        author_accent: author?.accent ?? null,
        reply_author,
        reply_author_image,
        reply_author_accent,
        reply_body,
        reactions: reactionsFor(m.id),
        emojiDefs: emojiDefsFor(m),
      };
    });
    return { ...page, page: enriched };
  },
});

export const get = query({
  args: { id: v.string() },
  handler: (ctx, { id }) => ctx.db.get("messages", id),
});

export const send = mutation({
  args: {
    channelId: v.string(),
    body: v.string(),
    replyTo: v.optional(v.string()),
    // JSON array of uploaded media `{ url, kind, w, h, name?, size? }` (≤4).
    attachments: v.optional(v.string()),
  },
  handler: async (ctx, { channelId, body, replyTo, attachments }) => {
    const me = ctx.user;
    const channel = await ctx.db.get("channels", channelId);
    if (!channel) throw new Error("channel not found");
    const octx = await orbitContext(ctx.db, channel.orbit_id, me.subject);
    if (!octx.isMember) throw new Error("you are not a member of this orbit");
    if (!canSendInChannel(channel, octx)) {
      throw new Error("you don't have permission to send messages in this channel");
    }
    const text = body.trim();
    const attachmentsJson = sanitizeAttachments(attachments);
    // A message may be text-only, media-only, or both — but not empty.
    if (!text && !attachmentsJson) throw new Error("message is empty");
    let replyAuthor: string | null = null;
    if (replyTo) {
      const parent = await ctx.db.get("messages", replyTo);
      if (!parent || parent.channel_id !== channelId) {
        throw new Error("reply target not found in this channel");
      }
      replyAuthor = parent.author_id;
    }
    const id = newId("msg");
    const now = Date.now();
    await ctx.db.insert("messages", {
      id,
      channel_id: channelId,
      author_id: me.subject,
      body: text,
      edited: null,
      reply_to: replyTo ?? null,
      created_at: now,
      attachments: attachmentsJson,
      embeds: null,
    });

    // Unfurl any links out-of-band: schedule the embeds action to run AFTER this
    // mutation commits (it does network I/O, which must never block the write).
    if (/https?:\/\//i.test(text)) {
      ctx.scheduler.runAfter(0, internal.embeds.unfurl, { messageId: id });
    }

    // Fan out inbox notifications: one for the person replied to, plus one per
    // @mention (mentions ride as `[@Name](mention:userId)` links). Skip self and
    // anyone who isn't a member of the orbit.
    const recipients = new Map<string, "reply" | "mention">();
    if (replyAuthor && replyAuthor !== me.subject) recipients.set(replyAuthor, "reply");
    const mentionIds = new Set<string>();
    for (const m of text.matchAll(/\(mention:([^)\s]+)\)/g)) mentionIds.add(m[1]);
    if (mentionIds.size) {
      const members = await ctx.db.table("members").where({ orbit_id: channel.orbit_id }).collect();
      const memberSet = new Set(members.map((mm) => mm.user_id));
      for (const uid of mentionIds) {
        if (uid !== me.subject && memberSet.has(uid) && !recipients.has(uid)) recipients.set(uid, "mention");
      }
    }
    if (recipients.size) {
      const snippet = text
        .replace(/\[@([^\]]+)\]\(mention:[^)\s]+\)/g, "@$1")
        .replace(/\[:([^\]]+):\]\(emoji:[^)\s]+\)/g, ":$1:")
        .replace(/[*_`~>#]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140);
      for (const [uid, kind] of recipients) {
        await ctx.db.insert("notifications", {
          id: newId("ntf"),
          user_id: uid,
          actor_id: me.subject,
          kind,
          orbit_id: channel.orbit_id,
          channel_id: channelId,
          message_id: id,
          snippet,
          read: null,
          created_at: now,
        });
      }

      // Deliver Web Push out-of-band: SCHEDULE the notify action to run after
      // this mutation commits. The slow/failable network send happens entirely
      // outside the transaction, so it can never block or roll back this write.
      ctx.scheduler.runAfter(0, internal.push.notify, {
        userIds: [...recipients.keys()],
        title: `${String(me.name ?? "Someone")} · #${channel.name}`,
        body: snippet,
        url: `/o/${channel.orbit_id}/c/${channelId}?at=${id}`,
        tag: id,
      });
    }
    return { id };
  },
});

/** Validate + normalize the client's attachments JSON: at most 4 entries, each a
 *  http(s) image/video URL with numeric dimensions. Returns a re-stringified
 *  clean array, or null if there's nothing usable. */
function sanitizeAttachments(json: string | undefined): string | null {
  if (!json) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const clean = arr
    .slice(0, 4)
    .map((a) => a as Record<string, unknown>)
    .filter((a) => typeof a?.url === "string" && /^https?:\/\//.test(a.url as string))
    .map((a) => ({
      url: a.url as string,
      kind: a.kind === "video" ? "video" : "image",
      w: Number(a.w) || 0,
      h: Number(a.h) || 0,
      ...(typeof a.name === "string" ? { name: (a.name as string).slice(0, 120) } : {}),
      ...(Number(a.size) ? { size: Number(a.size) } : {}),
    }));
  return clean.length ? JSON.stringify(clean) : null;
}

/** Edit your own message. */
export const edit = mutation({
  args: { id: v.string(), body: v.string() },
  handler: async (ctx, { id, body }) => {
    const me = ctx.user;
    const message = await ctx.db.get("messages", id);
    if (!message) throw new Error("message not found");
    if (message.author_id !== me.subject) throw new Error("you can only edit your own messages");
    await ctx.db.patch("messages", id, { body: body.trim(), edited: true });
  },
});

/** Delete a message — your own, or anyone's with MANAGE_MESSAGES. */
export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const me = ctx.user;
    const message = await ctx.db.get("messages", id);
    if (!message) return;
    const channel = await ctx.db.get("channels", message.channel_id);
    const own = message.author_id === me.subject;
    if (!own && channel) {
      const octx = await orbitContext(ctx.db, channel.orbit_id, me.subject);
      if (!can(octx, Perm.MANAGE_MESSAGES)) throw new Error("you can't delete others' messages");
    } else if (!own) {
      throw new Error("not allowed");
    }
    await ctx.db.delete("messages", id);
  },
});
