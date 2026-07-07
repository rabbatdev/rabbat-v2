// Link unfurling — turns URLs in a message into rich embeds, computed out of
// band so the slow/failable network fetch never touches the write transaction.
//
// messages.send SCHEDULES `unfurl` after it commits. The action reads the
// message body (runQuery), fetches each link, and writes the resulting embeds
// back (runMutation). Three embed shapes:
//   • { type: "image" | "video", url, w?, h? }   — a direct media link
//   • { type: "link", url, title, description?, image?, site? }  — OG card
//   • { type: "tweet", url, author, text, photos[], video? }     — X/Twitter,
//     carrying the post's FULL photo gallery via the public syndication API.

import { v } from "rabbat/functions";

import { internalQuery, internalMutation, internalAction } from "./setup.ts";
import { internal } from "../_generated/api.ts";

const MAX_EMBEDS = 3; // a handful of links per message, at most
const FETCH_TIMEOUT = 6000;
const UA =
  "Mozilla/5.0 (compatible; en-bot/1.0; +https://en.winglee.dev) facebookexternalhit/1.1";

// http(s) URLs in plain text. Mentions/emoji ride as `(mention:…)`/`(emoji:…)`
// link targets (no scheme), so they never match.
const URL_RE = /https?:\/\/[^\s<>()"']+/gi;

// ── internal helpers the action reaches the DB through ──────────────────────
export const getBody = internalQuery({
  args: { messageId: v.string() },
  handler: async (ctx, { messageId }) => {
    const m = await ctx.db.get("messages", messageId);
    return m ? { body: m.body } : null;
  },
});

export const setEmbeds = internalMutation({
  args: { messageId: v.string(), embeds: v.string() },
  handler: async (ctx, { messageId, embeds }) => {
    const m = await ctx.db.get("messages", messageId);
    if (!m) return; // deleted before we finished fetching
    await ctx.db.patch("messages", messageId, { embeds });
  },
});

export const unfurl = internalAction({
  args: { messageId: v.string() },
  handler: async (ctx, { messageId }) => {
    const msg = await ctx.runQuery(internal.embeds.getBody, { messageId });
    if (!msg) return;
    const urls = dedupe([...msg.body.matchAll(URL_RE)].map((m) => m[0])).slice(0, MAX_EMBEDS);
    if (urls.length === 0) return;

    const embeds = (await Promise.all(urls.map((u) => buildEmbed(u).catch(() => null)))).filter(
      (e): e is Embed => !!e,
    );
    if (embeds.length) {
      await ctx.runMutation(internal.embeds.setEmbeds, { messageId, embeds: JSON.stringify(embeds) });
    }
  },
});

// ── embed building ──────────────────────────────────────────────────────────
type Photo = { url: string; w: number; h: number };
type Embed =
  | { type: "image" | "video"; url: string; w?: number; h?: number }
  | { type: "youtube"; url: string; videoId: string; title?: string; author?: string; thumbnail?: string }
  | { type: "link"; url: string; title: string; description?: string; image?: string; site?: string }
  | {
      type: "tweet";
      url: string;
      author: { name: string; handle: string; avatar?: string };
      text: string;
      photos: Photo[];
      video?: { url: string; poster?: string; w: number; h: number };
      createdAt?: string;
    };

async function buildEmbed(url: string): Promise<Embed | null> {
  const yt = youtubeId(url);
  if (yt) return youtubeEmbed(url, yt);
  const id = tweetId(url);
  if (id) return tweetEmbed(url, id);
  return ogEmbed(url);
}

// ── YouTube (watch / youtu.be / shorts) via oEmbed ──────────────────────────
function youtubeId(url: string): string | null {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i,
  );
  return m ? m[1] : null;
}

async function youtubeEmbed(url: string, id: string): Promise<Embed> {
  let title: string | undefined;
  let author: string | undefined;
  try {
    const o = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`,
      { headers: { "user-agent": UA }, signal: withTimeout() },
    );
    if (o.ok) {
      const j = (await o.json()) as { title?: string; author_name?: string };
      title = j.title;
      author = j.author_name;
    }
  } catch {
    // oEmbed is best-effort; the embed still works from the id alone.
  }
  return { type: "youtube", url, videoId: id, title, author, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function withTimeout(): AbortSignal {
  // AbortSignal.timeout is available on Node 18+; fall back to a manual controller.
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(FETCH_TIMEOUT);
  const c = new AbortController();
  setTimeout(() => c.abort(), FETCH_TIMEOUT);
  return c.signal;
}

// ── X / Twitter via the public syndication API (carries ALL photos) ─────────
function tweetId(url: string): string | null {
  // Boundary (`//` after the scheme, or a `.` subdomain) so "max.com" doesn't
  // match the "x.com" substring, while "x.com" / "www.x.com" / "twitter.com" do.
  const m = url.match(/(?:\/\/|\.)(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/i);
  return m ? m[1] : null;
}

// The syndication endpoint needs a token derived from the tweet id (the same
// scheme react-tweet uses).
function tweetToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function tweetEmbed(url: string, id: string): Promise<Embed | null> {
  const api = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${tweetToken(id)}&lang=en`;
  const res = await fetch(api, { headers: { "user-agent": UA, accept: "application/json" }, signal: withTimeout() });
  if (!res.ok) return null;
  const t = (await res.json()) as TweetResult;
  if (!t || (!t.text && !t.mediaDetails?.length)) return null;

  const photos: Photo[] = [];
  let video: { url: string; poster?: string; w: number; h: number } | undefined;
  for (const md of t.mediaDetails ?? []) {
    const w = md.original_info?.width ?? md.sizes?.large?.w ?? 0;
    const h = md.original_info?.height ?? md.sizes?.large?.h ?? 0;
    if (md.type === "photo") {
      photos.push({ url: md.media_url_https, w, h });
    } else if ((md.type === "video" || md.type === "animated_gif") && !video) {
      const variants = (md.video_info?.variants ?? []).filter((x) => x.content_type === "video/mp4");
      variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      const best = variants[0];
      if (best) video = { url: best.url, poster: md.media_url_https, w: w || 16, h: h || 9 };
    }
  }
  return {
    type: "tweet",
    url,
    author: {
      name: t.user?.name ?? "",
      handle: t.user?.screen_name ?? "",
      avatar: t.user?.profile_image_url_https,
    },
    text: stripTrailingMediaUrl(t.text ?? ""),
    photos,
    video,
    createdAt: t.created_at,
  };
}

// The tweet text ends with a t.co link to its own media — drop it.
function stripTrailingMediaUrl(text: string): string {
  return text.replace(/\s*https?:\/\/t\.co\/\w+\s*$/i, "").trim();
}

// ── Generic Open Graph / direct media ───────────────────────────────────────
async function ogEmbed(url: string): Promise<Embed | null> {
  // Fast path: a URL that *looks* like direct media — trust the extension so the
  // embed doesn't depend on the host allowing our bot user-agent (some 403 it).
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(path)) return { type: "image", url };
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(path)) return { type: "video", url };

  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*" },
    redirect: "follow",
    signal: withTimeout(),
  });
  if (!res.ok) return null;
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const final = res.url || url;
  if (ct.startsWith("image/")) return { type: "image", url: final };
  if (ct.startsWith("video/")) return { type: "video", url: final };
  if (!ct.includes("html")) return null;

  const html = (await res.text()).slice(0, 600_000);
  const title =
    meta(html, "og:title") ?? meta(html, "twitter:title") ?? titleTag(html);
  const image = absolutize(meta(html, "og:image") ?? meta(html, "twitter:image"), final);
  const description = meta(html, "og:description") ?? meta(html, "twitter:description") ?? undefined;
  const site = meta(html, "og:site_name") ?? hostOf(final);
  if (!title && !image) return null;
  return { type: "link", url: final, title: title ?? hostOf(final), description, image: image ?? undefined, site };
}

// Match `<meta ... (property|name)="key" ... content="…" …>` in any attr order.
function meta(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRe(key)}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  if (!tag) return null;
  const c = tag.match(/\scontent=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]) : null;
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

function absolutize(src: string | null, base: string): string | null {
  if (!src) return null;
  try {
    return new URL(src, base).toString();
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

// ── syndication response shape (only the fields we read) ─────────────────────
interface TweetResult {
  text?: string;
  created_at?: string;
  user?: { name?: string; screen_name?: string; profile_image_url_https?: string };
  mediaDetails?: Array<{
    type: "photo" | "video" | "animated_gif";
    media_url_https: string;
    original_info?: { width?: number; height?: number };
    sizes?: { large?: { w?: number; h?: number } };
    video_info?: { variants?: Array<{ content_type?: string; url: string; bitrate?: number }> };
  }>;
}
