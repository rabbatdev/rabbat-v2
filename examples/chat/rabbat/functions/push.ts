// Web Push — VAPID-signed notifications delivered to a browser/device even when
// the app's tab is closed.
//
// The SEND path is deliberately decoupled from the transactional mutation that
// creates a notification: messages.send SCHEDULES the `notify` action via
// `ctx.scheduler.runAfter(0, internal.push.notify, …)`. The action runs AFTER
// the message + notification rows commit, fully outside the transaction — so a
// slow or failed push can never block the write, fail the mutation, or roll
// anything back. The action reaches the DB only through runQuery/runMutation
// (each its own transaction), never holding the write path open for network I/O.

import webpush from "web-push";

import { v } from "rabbat/functions";
import { mutation, query, publicQuery, internalQuery, internalMutation, internalAction } from "./setup.ts";
import { newId } from "./util.ts";
import { internal } from "../_generated/api.ts";

// VAPID is initialized lazily on first use, not at import time: the dev server
// loads its `.env` *after* ES modules are evaluated, so reading process.env here
// at import would miss the keys. (Prod gets them straight from the environment.)
let vapidReady = false;
let pushEnabled = false;
let vapidPublic = "";
function ensureVapid(): void {
  if (vapidReady) return;
  vapidReady = true;
  vapidPublic = process.env.VAPID_PUBLIC_KEY ?? "";
  const priv = process.env.VAPID_PRIVATE_KEY ?? "";
  const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@en.local";
  pushEnabled = !!vapidPublic && !!priv;
  if (pushEnabled) webpush.setVapidDetails(subject, vapidPublic, priv);
}

/** The client needs the VAPID public key to subscribe; `enabled` gates the UI. */
export const config = query({
  args: {},
  handler: () => {
    ensureVapid();
    return { enabled: pushEnabled, publicKey: vapidPublic };
  },
});

/** How many push devices the caller has registered (drives the settings copy). */
export const status = publicQuery({
  args: {},
  handler: async (ctx) => {
    const me = ctx.identity;
    if (!me) return { count: 0 };
    const rows = await ctx.db.table("push_subscriptions").where({ user_id: me.subject }).collect();
    return { count: rows.length };
  },
});

/** Register (or refresh) this device's push subscription. */
export const subscribe = mutation({
  args: { endpoint: v.string(), p256dh: v.string(), auth: v.string(), ua: v.optional(v.string()) },
  handler: async (ctx, { endpoint, p256dh, auth, ua }) => {
    const me = ctx.user;
    const existing = await ctx.db.table("push_subscriptions").where({ endpoint }).first();
    if (existing) {
      await ctx.db.patch("push_subscriptions", existing.id, { user_id: me.subject, p256dh, auth, ua: ua ?? null });
      return { id: existing.id };
    }
    const id = newId("push");
    await ctx.db.insert("push_subscriptions", {
      id,
      user_id: me.subject,
      endpoint,
      p256dh,
      auth,
      ua: ua ?? null,
      created_at: Date.now(),
    });
    return { id };
  },
});

/** Drop this device's subscription (used when the user disables notifications). */
export const unsubscribe = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const me = ctx.user;
    const existing = await ctx.db.table("push_subscriptions").where({ endpoint }).first();
    if (existing && existing.user_id === me.subject) await ctx.db.delete("push_subscriptions", existing.id);
  },
});

// ── The sender: an internal action, scheduled from messages.send ─────────────
// Reaches the DB only via runQuery/runMutation, so the slow web-push network I/O
// lives entirely outside any transaction.

/** Internal: this user's push subscriptions (the fields needed to send). */
export const subsFor = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db.table("push_subscriptions").where({ user_id: userId }).collect();
    return rows.map((r) => ({ id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
  },
});

/** Internal: drop a dead subscription (when a push 404/410s). */
export const removeSub = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    await ctx.db.delete("push_subscriptions", id);
  },
});

/** Internal action: deliver a Web Push to every device of the given users.
 *  Scheduled (never client-callable). Best-effort: prunes dead subscriptions. */
export const notify = internalAction({
  args: {
    userIds: v.array(v.string()),
    title: v.string(),
    body: v.string(),
    url: v.string(),
    tag: v.optional(v.string()),
  },
  handler: async (ctx, { userIds, title, body, url, tag }) => {
    ensureVapid();
    if (!pushEnabled) {
      console.warn("[push] notify skipped — VAPID keys not configured");
      return;
    }
    if (userIds.length === 0) return;
    const data = JSON.stringify({ title, body, url, tag });
    let subsTotal = 0;
    let sent = 0;
    let failed = 0;
    for (const uid of [...new Set(userIds)]) {
      const subs = await ctx.runQuery(internal.push.subsFor, { userId: uid });
      subsTotal += subs.length;
      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            data,
          );
          sent++;
        } catch (err) {
          failed++;
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            await ctx.runMutation(internal.push.removeSub, { id: sub.id }).catch(() => {});
          } else {
            // 403 ⇒ VAPID key mismatch; others ⇒ push-service errors. Log so a
            // silently-failing delivery is diagnosable from the server logs.
            console.error("[push] send failed:", code, (err as Error).message?.slice(0, 180));
          }
        }
      }
    }
    console.log(`[push] notify users=${[...new Set(userIds)].length} subs=${subsTotal} sent=${sent} failed=${failed}`);
  },
});
