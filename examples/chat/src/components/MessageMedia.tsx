// Renders a message's media + link embeds *inside* the virtualized list. Mugen
// needs a known height per row, so everything here computes a deterministic
// height (from stored media dimensions + a text-wrap estimate) and reserves it
// with a single <Escape> block. Uploaded media carry real w/h; embeds carry
// dimensions from the OG/syndication unfurl.
//
// Width matters: the reserved height MUST be computed at the SAME width the card
// renders at, or the content overflows the reserved row and clips. The card is
// `min(MEDIA_W, columnWidth)` wide, so `MessageList` measures the column and
// passes `maxW` — which is narrower than MEDIA_W on a phone (or under Safari
// page-zoom, which shrinks the CSS viewport). Everything below derives from it.

import { useMemo, useRef, useState } from "react";
import { Loader2, Maximize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { Escape } from "@wingleeio/mugen";
import { measureInline } from "@wingleeio/mugen-markdown";

import { useLightbox, type LightboxItem } from "@/context/lightbox";
import { MessageImage } from "./MessageImage";
import { cn } from "@/lib/utils";

// ── shared types (mirror functions/embeds.ts + the attachments JSON) ─────────
type Attachment = { url: string; kind: "image" | "video"; w: number; h: number; name?: string; size?: number };
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

// ── sizing constants ─────────────────────────────────────────────────────────
const MEDIA_W = 380; // max media/card width (the cap; actual width can be narrower)
const MEDIA_MAX_H = 300; // max single-media height
const BLOCK_GAP = 6; // gap between stacked blocks
const GRID_GAP = 3; // gap between gallery cells
const CELL_H = 128; // gallery cell height (object-cover)
const CARD_PAD = 12;
const TEXT_FONT = "15px Geist";
const TEXT_LH = 21;
const LINK_H = 96; // fixed link-card height (site + 1-line title + 2-line desc)
const CARD_MEDIA_MAX_H = 440; // cap for full-bleed card media (taller crops)

const ytH = (cardW: number) => Math.round((cardW * 9) / 16); // 16:9 player box

/** Height of full-bleed card media: full card width, aspect-preserved, capped. */
function bleedH(w: number, h: number, maxW: number): number {
  const ratio = w > 0 && h > 0 ? h / w : 9 / 16;
  return Math.round(Math.min(maxW * ratio, CARD_MEDIA_MAX_H));
}

function parse<T>(json: string | null | undefined): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** Fit (w,h) into a maxW×maxH box, preserving aspect. Unknown dimensions (a
 *  direct media URL we never measured) fall back to a full-width 16:9 box. */
function fit(w: number, h: number, maxW = MEDIA_W, maxH = MEDIA_MAX_H): { w: number; h: number } {
  const known = w > 0 && h > 0;
  const ratio = known ? h / w : 9 / 16;
  let dw = known ? Math.min(w, maxW) : maxW;
  let dh = dw * ratio;
  if (dh > maxH) {
    dh = maxH;
    dw = dh / ratio;
  }
  return { w: Math.round(dw), h: Math.round(dh) };
}

const galleryRows = (n: number) => Math.ceil(n / 2);
const galleryHeight = (n: number) => galleryRows(n) * CELL_H + (galleryRows(n) - 1) * GRID_GAP;

/** Height of a media set: a single item fits to aspect; 2+ become a 2-col grid. */
function mediaHeight(items: { w?: number; h?: number }[], maxW: number): number {
  if (items.length === 0) return 0;
  if (items.length === 1) return fit(items[0].w ?? 0, items[0].h ?? 0, maxW).h;
  return galleryHeight(items.length);
}

/** Estimate wrapped line count of `text` at `width` (slightly conservative). */
function lineCount(text: string, width: number, max: number): number {
  if (!text) return 0;
  let lines = 0;
  for (const seg of text.split("\n")) {
    const px = measureInline(seg || " ", TEXT_FONT);
    lines += Math.max(1, Math.ceil(px / (width * 0.92)));
  }
  return Math.min(lines, max);
}

function tweetTextHeight(text: string, cardW: number): number {
  const lines = lineCount(text, cardW - 2 * CARD_PAD, 12);
  return lines * TEXT_LH;
}

function tweetHeight(t: Extract<Embed, { type: "tweet" }>, cardW: number): number {
  const header = 40;
  const textH = t.text ? tweetTextHeight(t.text, cardW) : 0;
  // Header + text sit in a padded block; media is full-bleed below it (flush to
  // the card's left/right/bottom edges, no extra gap).
  const contentPad = CARD_PAD * 2 + header + (textH ? 8 + textH : 0);
  let mediaH = 0;
  if (t.photos.length === 1) mediaH = bleedH(t.photos[0].w, t.photos[0].h, cardW);
  else if (t.photos.length > 1) mediaH = galleryHeight(t.photos.length);
  else if (t.video) mediaH = bleedH(t.video.w, t.video.h, cardW);
  return mediaH ? contentPad + mediaH : contentPad;
}

function embedHeight(e: Embed, cardW: number): number {
  if (e.type === "link") return LINK_H;
  if (e.type === "tweet") return tweetHeight(e, cardW);
  if (e.type === "youtube") return ytH(cardW);
  return fit(e.w ?? 0, e.h ?? 0, cardW).h; // direct image/video
}

// ── rendering ────────────────────────────────────────────────────────────────
function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** A `<video>` with our own controls instead of the browser's.
 *
 *  Native controls paint a buffering spinner inside the video's shadow DOM that
 *  can't be recoloured or hidden from page CSS and renders as a dark arc in some
 *  engines — ugly on a dark embed. So we drop `controls` (no native spinner) and
 *  render a minimal player: click/▶ to play, a seek bar, time, mute, fullscreen,
 *  and our own white spinner while buffering. `style` carries the box size; the
 *  video fills it. `rounded` clips the controls to the card's rounded corners. */
function MessageVideo({
  src,
  poster,
  className,
  style,
  rounded = false,
}: {
  src: string;
  poster?: string;
  className?: string;
  style?: React.CSSProperties;
  rounded?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);

  const toggle = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const v = ref.current;
    if (!v || !dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    v.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * dur;
  };
  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    const v = ref.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };
  const fullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    const v = ref.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!v) return;
    if (v.requestFullscreen) void v.requestFullscreen().catch(() => {});
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iOS Safari
  };

  const pct = dur ? (cur / dur) * 100 : 0;

  return (
    <div className={cn("group/v relative overflow-hidden", rounded && "rounded-lg")} style={style}>
      <video
        ref={ref}
        src={src}
        poster={poster}
        playsInline
        onClick={toggle}
        className={cn("size-full cursor-pointer", className)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setLoading(true)}
        onStalled={() => setLoading(true)}
        onSeeking={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onCanPlay={() => setLoading(false)}
        onSeeked={() => setLoading(false)}
        onError={() => setLoading(false)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onDurationChange={(e) => setDur(e.currentTarget.duration || 0)}
        onEnded={() => setPlaying(false)}
      />

      {/* Centre: white spinner while buffering, else a play button when paused. */}
      {loading ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Loader2 className="size-9 animate-spin text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.55)]" />
        </div>
      ) : !playing ? (
        <button type="button" onClick={toggle} aria-label="Play" className="absolute inset-0 grid place-items-center">
          <span className="grid size-14 place-items-center rounded-full bg-black/55 backdrop-blur-sm transition-transform group-hover/v:scale-105">
            <Play className="size-6 translate-x-0.5 fill-white text-white" />
          </span>
        </button>
      ) : null}

      {/* Our control bar (fades in on hover while playing; pinned while paused). */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-6 text-white transition-opacity duration-150",
          playing ? "opacity-0 group-hover/v:opacity-100" : "opacity-100",
        )}
      >
        <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="shrink-0 opacity-90 hover:opacity-100">
          {playing ? <Pause className="size-[17px] fill-white" /> : <Play className="size-[17px] translate-x-px fill-white" />}
        </button>
        <div onClick={seek} className="relative h-3 flex-1 cursor-pointer">
          <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-white/30">
            <div className="h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-white/90">
          {fmtTime(cur)} / {fmtTime(dur)}
        </span>
        <button type="button" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} className="shrink-0 opacity-90 hover:opacity-100">
          {muted ? <VolumeX className="size-[17px]" /> : <Volume2 className="size-[17px]" />}
        </button>
        <button type="button" onClick={fullscreen} aria-label="Fullscreen" className="shrink-0 opacity-90 hover:opacity-100">
          <Maximize className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** A media set as a single image/video or a 2-col gallery grid. Images open the
 *  lightbox (with the whole set, so prev/next works); videos play inline.
 *  `flush`: render edge-to-edge with no radius (the enclosing card clips it). */
function MediaSet({
  items,
  maxW,
  flush = false,
}: {
  items: Attachment[] | (Photo & { kind?: undefined })[];
  maxW: number;
  flush?: boolean;
}) {
  const lb = useLightbox();
  if (items.length === 0) return null;
  const lbItems: LightboxItem[] = items.map((it) => ({ url: it.url, kind: ((it as Attachment).kind ?? "image") as "image" | "video" }));
  // Stop the click from also triggering the enclosing card (which opens the
  // tweet); photos should open the lightbox, not navigate.
  const openAt = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    lb?.open(lbItems, i);
  };

  if (items.length === 1) {
    const it = items[0] as Attachment;
    const fb = fit(it.w ?? 0, it.h ?? 0, maxW);
    const w = flush ? "100%" : fb.w;
    const h = flush ? bleedH(it.w ?? 0, it.h ?? 0, maxW) : fb.h;
    return it.kind === "video" ? (
      <MessageVideo src={it.url} rounded={!flush} className="bg-black object-contain" style={{ width: w, height: h }} />
    ) : (
      <MessageImage
        src={it.url}
        alt={(it as Attachment).name ?? ""}
        onClick={openAt(0)}
        className={cn("cursor-zoom-in object-cover", !flush && "rounded-lg")}
        style={{ width: w, height: h }}
      />
    );
  }
  return (
    <div className={cn("grid grid-cols-2 overflow-hidden", !flush && "rounded-lg")} style={{ gap: GRID_GAP, width: flush ? "100%" : maxW, maxWidth: "100%" }}>
      {items.map((it, i) => {
        const v = (it as Attachment).kind === "video";
        return v ? (
          <MessageVideo key={i} src={it.url} className="bg-black object-cover" style={{ height: CELL_H, width: "100%" }} />
        ) : (
          <MessageImage
            key={i}
            src={it.url}
            onClick={openAt(i)}
            className="cursor-zoom-in object-cover"
            style={{ height: CELL_H, width: "100%" }}
          />
        );
      })}
    </div>
  );
}

function TweetCard({ t, cardW }: { t: Extract<Embed, { type: "tweet" }>; cardW: number }) {
  const openTweet = () => window.open(t.url, "_blank", "noopener,noreferrer");
  // A div, not an <a>: an anchor would swallow clicks on the video controls
  // (navigating to the tweet instead of playing). Clicking the card background/
  // text opens the tweet; media stops propagation so it stays interactive.
  // overflow-hidden so the full-bleed media's corners are clipped by the card.
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={openTweet}
      onKeyDown={(e) => {
        if (e.key === "Enter") openTweet();
      }}
      className="block cursor-pointer overflow-hidden rounded-lg border border-border-strong bg-raised transition-colors hover:bg-elevated/40"
      style={{ width: cardW, maxWidth: "100%" }}
    >
      <div style={{ padding: CARD_PAD }}>
        <div className="flex items-center gap-2">
          {t.author.avatar ? (
            <img src={t.author.avatar} alt="" referrerPolicy="no-referrer" className="size-9 rounded-full object-cover" />
          ) : (
            <span className="size-9 rounded-full bg-elevated" />
          )}
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13.5px] font-semibold text-foreground">{t.author.name || "Tweet"}</div>
            {t.author.handle && <div className="truncate text-[12.5px] text-muted-foreground">@{t.author.handle}</div>}
          </div>
          <svg viewBox="0 0 24 24" aria-hidden className="size-[18px] shrink-0 fill-foreground/80">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </div>
        {t.text && (
          <div
            className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-[21px] text-message"
            style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 12, overflow: "hidden" }}
          >
            {t.text}
          </div>
        )}
      </div>
      {t.photos.length > 0 ? (
        <MediaSet items={t.photos.map((p) => ({ url: p.url, kind: "image" as const, w: p.w, h: p.h }))} maxW={cardW} flush />
      ) : t.video ? (
        <div onClick={(e) => e.stopPropagation()}>
          <MessageVideo
            src={t.video.url}
            poster={t.video.poster}
            className="block bg-black object-contain"
            style={{ width: "100%", height: bleedH(t.video.w, t.video.h, cardW) }}
          />
        </div>
      ) : null}
    </div>
  );
}

function YouTubeCard({ e, cardW }: { e: Extract<Embed, { type: "youtube" }>; cardW: number }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="relative overflow-hidden rounded-lg bg-black" style={{ width: cardW, maxWidth: "100%", height: ytH(cardW) }}>
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${e.videoId}?autoplay=1&rel=0`}
          title={e.title ?? "YouTube video"}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          // The document sets `no-referrer` (so twimg videos play); YouTube's
          // player needs the embedding origin to load, so opt this iframe back
          // into sending it.
          referrerPolicy="strict-origin-when-cross-origin"
          className="size-full"
          style={{ border: 0 }}
        />
      ) : (
        <button type="button" onClick={() => setPlaying(true)} aria-label={`Play ${e.title ?? "video"}`} className="group/yt block size-full">
          {e.thumbnail && <img src={e.thumbnail} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />}
          <span className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/15" />
          {e.title && (
            <span className="absolute inset-x-0 top-0 line-clamp-2 px-3 py-2.5 text-left text-[13px] font-semibold leading-snug text-white drop-shadow">
              {e.title}
            </span>
          )}
          <span className="absolute left-1/2 top-1/2 grid h-[44px] w-[62px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl bg-[#ff0000] shadow-lg transition-transform group-hover/yt:scale-110">
            <svg viewBox="0 0 24 24" aria-hidden className="size-7 translate-x-px fill-white">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
          {e.author && (
            <span className="absolute bottom-0 left-0 px-3 py-2 text-[11.5px] font-medium text-white/90 drop-shadow">{e.author}</span>
          )}
        </button>
      )}
    </div>
  );
}

function LinkCard({ e, cardW }: { e: Extract<Embed, { type: "link" }>; cardW: number }) {
  return (
    <a
      href={e.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-stretch overflow-hidden rounded-lg border border-border-strong bg-raised no-underline transition-colors hover:bg-elevated/40"
      style={{ width: cardW, maxWidth: "100%", height: LINK_H }}
    >
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5" style={{ padding: CARD_PAD }}>
        {e.site && <div className="truncate text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{e.site}</div>}
        <div className="truncate text-[13.5px] font-semibold leading-snug text-foreground">{e.title}</div>
        {e.description && (
          <div
            className="text-[12.5px] leading-[16px] text-muted-foreground"
            style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }}
          >
            {e.description}
          </div>
        )}
      </div>
      {e.image && (
        <img src={e.image} alt="" referrerPolicy="no-referrer" className="h-full shrink-0 object-cover" style={{ width: 124 }} />
      )}
    </a>
  );
}

/** All of a message's attachments + embeds, in one fixed-height Escape block.
 *  `maxW` is the real column width (≤ MEDIA_W); height + render both use it. */
export function MessageMedia({
  attachments,
  embeds,
  maxW = MEDIA_W,
}: {
  attachments?: string | null;
  embeds?: string | null;
  maxW?: number;
}) {
  const atts = useMemo(() => parse<Attachment[]>(attachments) ?? [], [attachments]);
  const embs = useMemo(() => parse<Embed[]>(embeds) ?? [], [embeds]);
  const w = Math.min(MEDIA_W, maxW);

  const { total, blocks } = useMemo(() => {
    const heights: number[] = [];
    if (atts.length) heights.push(mediaHeight(atts, w));
    for (const e of embs) heights.push(embedHeight(e, w));
    const blocks = heights.length;
    const total = blocks === 0 ? 0 : heights.reduce((a, b) => a + b, 0) + BLOCK_GAP * (blocks - 1) + 4;
    return { total, blocks };
  }, [atts, embs, w]);

  if (blocks === 0) return null;

  return (
    <Escape height={total}>
      <div className="flex flex-col pt-1" style={{ gap: BLOCK_GAP }}>
        {atts.length > 0 && <MediaSet items={atts} maxW={w} />}
        {embs.map((e, i) => {
          if (e.type === "tweet") return <TweetCard key={i} t={e} cardW={w} />;
          if (e.type === "youtube") return <YouTubeCard key={i} e={e} cardW={w} />;
          if (e.type === "link") return <LinkCard key={i} e={e} cardW={w} />;
          return <MediaSet key={i} items={[{ url: e.url, kind: e.type === "video" ? "video" : "image", w: e.w ?? 0, h: e.h ?? 0 }]} maxW={w} />;
        })}
      </div>
    </Escape>
  );
}
