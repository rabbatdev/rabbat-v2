import { v } from "rabbat/functions";

import { mutation, query, publicQuery } from "./setup.ts";

/** The signed-in user's own profile. `name` is the display name; `username` is
 *  the unique @handle (null until they pick one). */
export const me = publicQuery({
  args: {},
  handler: async (ctx) => {
    const me = ctx.identity;
    if (!me) return null;
    const u = await ctx.db.get("user", me.subject);
    if (!u) return null;
    return {
      id: u.id,
      name: u.name,
      username: u.username ?? null,
      email: u.email,
      image: u.image,
      cover: u.cover,
      bio: u.bio,
      accent: u.accent,
    };
  },
});

/** A public profile by id (profile cards). */
export const get = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const u = await ctx.db.get("user", userId);
    if (!u) return null;
    return {
      id: u.id,
      name: u.name,
      username: u.username ?? null,
      image: u.image,
      cover: u.cover,
      bio: u.bio,
      accent: u.accent,
    };
  },
});

const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;

/** Update your own profile: display name, unique @username, bio, accent,
 *  avatar, cover banner. */
export const update = mutation({
  args: {
    displayName: v.optional(v.string()),
    username: v.optional(v.string()),
    bio: v.optional(v.string()),
    accent: v.optional(v.string()),
    image: v.optional(v.string()),
    cover: v.optional(v.string()),
  },
  handler: async (ctx, { displayName, username, bio, accent, image, cover }) => {
    const me = ctx.user;
    const patch: {
      name?: string;
      username?: string | null;
      bio?: string | null;
      accent?: string | null;
      image?: string | null;
      cover?: string | null;
    } = {};

    if (displayName !== undefined) {
      const n = displayName.trim().slice(0, 32);
      if (!n) throw new Error("Display name can't be empty.");
      patch.name = n;
    }

    if (username !== undefined) {
      const handle = username.trim().toLowerCase();
      if (handle === "") {
        patch.username = null;
      } else {
        if (!USERNAME_RE.test(handle)) {
          throw new Error("Username must be 3–20 characters: lowercase letters, numbers, _ or .");
        }
        const existing = await ctx.db.table("user").where({ username: handle }).first();
        if (existing && existing.id !== me.subject) throw new Error("That username is taken.");
        patch.username = handle;
      }
    }

    if (bio !== undefined) patch.bio = bio.trim().slice(0, 280) || null;
    if (accent !== undefined) patch.accent = accent || null;
    if (image !== undefined) patch.image = image || null;
    if (cover !== undefined) patch.cover = cover || null;

    if (Object.keys(patch).length) await ctx.db.patch("user", me.subject, patch);
  },
});
