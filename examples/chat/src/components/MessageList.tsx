import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent, type ReactNode } from "react";
import { useRouter } from "@rabbat/react";
import { usePaginatedQuery, useMutation } from "@rabbat/react";
import { ArrowDown, Copy, Pencil, Reply, SmilePlus, Trash2 } from "lucide-react";
import {
  Escape,
  HStack,
  MugenVList,
  Portal,
  Text,
  useMugenSelector,
  useMugenVirtualizer,
  VStack,
  type MugenInstance,
} from "@wingleeio/mugen";
import { Markdown, defineMarkdownComponents, measureInline, type MarkdownComponents, type RichTextRun } from "@wingleeio/mugen-markdown";
import { MENTION_FONT, MENTION_PAD, mentionChipStyle } from "@/lib/mention";
import { EMOJI_PAD, EMOJI_SIZE, customEmojiImgStyle, customIdOf, reactionValue, splitEmoji, unicodeEmojiStyle } from "@/lib/emoji";
import { EmojiPicker } from "./EmojiPicker";

import { api, type Message } from "@/rabbat";
import { useIdentity } from "@/context/identity";
import { useMemberCard } from "@/context/member-card";
import { useOrbit } from "@/context/orbit-context";
import { Perm, hasPerm } from "@/lib/perms";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useContextMenu, type MenuItem } from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "./ConfirmDialog";
import { MessageMedia } from "./MessageMedia";
import { cn } from "@/lib/utils";
import { errorMessage, bodyPreview, formatTime, initials, userColor } from "@/lib/util";

export interface ReplyTarget {
  id: string;
  author_name: string;
  body: string;
}
export interface EditTarget {
  id: string;
  body: string;
}

interface Props {
  orbitId: string;
  channelId: string;
  channelName?: string;
  anchor: string | null;
  onReply: (m: ReplyTarget) => void;
  onEdit: (m: EditTarget) => void;
}

const PAGE = 40;
const BODY_FONT = "15px Geist";
const BODY_LH = 22;
const LEFT = 16;
const AV = 36;
const GAP = 12;
// Right gutter: generous on desktop, but on mobile a 48px right gutter against
// the 16px left looks lopsided and wastes width — match it down to the left.
const RIGHT =
  typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches ? 16 : 48;

// The media/embed column width = list width minus the row gutters, capped at the
// embed max. MessageMedia computes its reserved row height at exactly this width,
// so it must track the real column — which shrinks on a narrow phone and under
// Safari page-zoom (it shrinks the CSS viewport). A few px of slack so the card
// never equals the column (sub-pixel overflow would clip the reserved row).
const MEDIA_MAXW = 380;
const MEDIA_GUTTERS = LEFT + AV + GAP + RIGHT;
const computeMediaW = (hostW: number) =>
  Math.max(200, Math.min(MEDIA_MAXW, Math.floor(hostW - MEDIA_GUTTERS - 4)));
const initialMediaW = () => {
  if (typeof window === "undefined") return MEDIA_MAXW;
  const mobile = window.matchMedia?.("(max-width: 640px)").matches;
  // Desktop columns are comfortably wider than the cap; mobile ≈ full viewport.
  return computeMediaW(mobile ? window.innerWidth : 900);
};

// Touch devices have no hover, so the per-message action toolbar is revealed by
// pressing-and-holding the message (desktop keeps hover).
const IS_TOUCH = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
const LONG_PRESS_MS = 420;

// Imperative reveal of a message's action toolbar on touch (the virtualizer
// doesn't re-render mounted rows on a state change). One at a time; dismissed by
// tapping elsewhere or scrolling.
let activeDismiss: (() => void) | null = null;
function hideMessageActions(): void {
  document.querySelectorAll(".rb-row.show-actions").forEach((el) => el.classList.remove("show-actions"));
  activeDismiss?.();
  activeDismiss = null;
}
function revealMessageActions(row: HTMLElement): void {
  hideMessageActions();
  row.classList.add("show-actions");
  const onDown = (e: Event) => {
    // Keep it open while using the toolbar; otherwise any tap elsewhere closes it.
    if ((e.target as HTMLElement)?.closest?.(".msg-actions")) return;
    hideMessageActions();
  };
  const scroller = row.closest(".rb-scroll");
  // Defer so the long-press's own touch sequence doesn't immediately dismiss it.
  const raf = requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onDown, true);
    scroller?.addEventListener("scroll", hideMessageActions, true);
  });
  activeDismiss = () => {
    cancelAnimationFrame(raf);
    document.removeEventListener("pointerdown", onDown, true);
    scroller?.removeEventListener("scroll", hideMessageActions, true);
  };
}

const FAINT = "var(--faint)";

// One-tap reactions surfaced on the hover toolbar (the picker covers the rest).
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉"];

// Markdown theme for message bodies — matches the app's Geist body type.
const MD_THEME = {
  fontFamily: "Geist",
  monoFamily: "Geist Mono",
  fontSize: 15,
  lineHeight: 22,
  color: "var(--message)",
  blockGap: 6,
  strongWeight: 700,
  emphasisItalic: true,
  link: { color: "var(--primary)", underline: true },
  inlineCode: { color: "var(--foreground)", background: "var(--raised)", sizeScale: 0.92 },
  code: { background: "var(--raised)", color: "var(--message)" },
};

function linkLabel(node: { children: ReadonlyArray<unknown>; url: string }): string {
  const parts = node.children.map((c) => (c && typeof c === "object" && "value" in c ? String((c as { value: unknown }).value) : ""));
  return parts.join("") || node.url;
}

// Human-readable text for "Copy text" / re-paste: mentions → @name, custom emoji
// → :name: shorthand (which the composer expands back into the emoji on send).
function humanizeBody(body: string): string {
  return body
    .replace(/\[@([^\]]+)\]\(mention:[^)\s]+\)/g, "@$1")
    .replace(/\[:([^\]]+):\]\(emoji:[^)\s]+\)/g, ":$1:");
}

const dayKey = (ms: number) => new Date(ms).toDateString();
const dayLabel = (ms: number) => {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return "Today";
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
};
const shortTime = (ms: number) => {
  const d = new Date(ms);
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export interface ReactionAgg {
  emoji: string;
  count: number;
  mine: boolean;
  users: { id: string; name: string }[];
}

type EnrichedMsg = Message & {
  author_name: string;
  author_image: string | null;
  author_accent: string | null;
  reply_author: string | null;
  reply_author_image: string | null;
  reply_author_accent: string | null;
  reply_body: string | null;
  reactions: ReactionAgg[];
  emojiDefs: { id: string; name: string; url: string }[];
};

type ReplyInfo =
  | { status: "none" }
  | { status: "deleted" }
  | { status: "ok"; author: string; image: string | null; accent: string | null; body: string };

type MsgItem = Message & {
  kind: "msg";
  key: string;
  grouped: boolean;
  reply: ReplyInfo;
  mine: boolean;
  canManage: boolean;
  authorName: string;
  authorImage: string | null;
  authorAccent: string | null;
  reactions: ReactionAgg[];
};
type Item = { kind: "day"; key: string; ms: number } | MsgItem;

export function MessageList({ orbitId, channelId, channelName, anchor, onReply, onEdit }: Props) {
  const router = useRouter();
  const me = useIdentity();
  const memberCard = useMemberCard();
  const orbit = useOrbit();
  const openMenu = useContextMenu();
  const canManageMessages = hasPerm(orbit, Perm.MANAGE_MESSAGES);
  const result = usePaginatedQuery(api.messages.list, { channelId }, { initialNumItems: PAGE, anchor });
  const messages = result.data as EnrichedMsg[];
  const removeMessage = useMutation(api.messages.remove);
  const toggleReaction = useMutation(api.reactions.toggle);
  const { confirm, confirmDialog } = useConfirm();

  // Custom emoji id→url, resolved server-side and bundled with each message
  // (`emojiDefs`) so emoji from a server the viewer isn't in still render — and
  // they're present on first paint (the virtualized list won't re-run the
  // markdown override for a late-arriving map).
  const emojiUrlById = useMemo(() => {
    const m = new Map<string, string>();
    for (const msg of messages) for (const e of msg.emojiDefs ?? []) m.set(e.id, e.url);
    return m;
  }, [messages]);

  // One reaction picker for the whole list, anchored to whichever message's
  // "react" affordance opened it (the hover toolbar or an existing pill row).
  const [reactionFor, setReactionFor] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const onReact = useCallback((id: string, anchor: HTMLElement) => setReactionFor({ id, anchor }), []);
  const onToggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      void toggleReaction({ messageId, emoji }).catch((err) => alert(errorMessage(err)));
    },
    [toggleReaction],
  );
  // Right-click a reaction → who reacted with it.
  const onReactionContext = useCallback(
    (e: ReactMouseEvent, r: ReactionAgg) => {
      e.preventDefault();
      e.stopPropagation();
      const items: MenuItem[] = [
        { type: "label", label: r.count === 1 ? "1 reaction" : `${r.count} reactions` },
        { type: "separator" },
        ...r.users.slice(0, 30).map((u) => ({ type: "label" as const, label: u.name })),
      ];
      if (r.users.length > 30) items.push({ type: "label", label: `+${r.users.length - 30} more` });
      openMenu(e, items);
    },
    [openMenu],
  );

  // Refs read by callbacks that are defined before `list`/`items` exist.
  const listRef = useRef<MugenInstance<Item> | null>(null);
  const loadedIdsRef = useRef<Set<string>>(new Set());
  const pendingBottom = useRef(false);

  const jumpTo = useCallback(
    (id: string) => {
      const list = listRef.current;
      // If the target is already loaded, scroll to it in place — NO URL anchor,
      // so a reply to a nearby message never drops us into a lingering
      // "anchored" state (which made the Back-to-latest button misbehave).
      if (list && loadedIdsRef.current.has(id)) {
        let tries = 20;
        const land = () => {
          list.scrollToItem(id, { align: "center" });
          const el = document.getElementById(`msg-${id}`);
          if (el) return void flashEl(el);
          if (tries-- > 0) requestAnimationFrame(land);
        };
        requestAnimationFrame(land);
        return;
      }
      // Otherwise load the window around it via the URL anchor.
      void router.visit(`/o/${orbitId}/c/${channelId}?at=${id}`, { clientOnly: true });
    },
    [router, orbitId, channelId],
  );
  const backToLatest = useCallback(() => {
    // Clearing the anchor alone doesn't scroll; flag a settle-to-bottom for once
    // the live page is ready (see the effect below).
    pendingBottom.current = true;
    void router.visit(`/o/${orbitId}/c/${channelId}`, { clientOnly: true });
  }, [router, orbitId, channelId]);
  const onDelete = useCallback(
    async (id: string) => {
      if (await confirm({ title: "Delete message?", confirmLabel: "Delete", destructive: true })) {
        try {
          await removeMessage({ id });
        } catch (err) {
          alert(errorMessage(err));
        }
      }
    },
    [confirm, removeMessage],
  );

  const items = useMemo<Item[]>(() => {
    const replyOf = (m: EnrichedMsg): ReplyInfo =>
      m.reply_to == null
        ? { status: "none" }
        : m.reply_author != null
          ? { status: "ok", author: m.reply_author, image: m.reply_author_image, accent: m.reply_author_accent, body: m.reply_body ?? "" }
          : { status: "deleted" };
    const out: Item[] = [];
    let lastDay: string | null = null;
    let prev: EnrichedMsg | undefined;
    for (const m of messages) {
      const day = dayKey(m.created_at);
      const dayChanged = day !== lastDay;
      // A day divider belongs *between* two loaded messages of different days —
      // never as a leading item at the top of the window. The message "above"
      // the first one is either an older message not yet loaded (possibly the
      // same day) or nothing at all, so we can't claim a boundary there. As the
      // window grows upward, the divider re-appears at the real boundary once
      // both days are loaded.
      if (dayChanged && lastDay !== null) {
        out.push({ kind: "day", key: `day-${day}`, ms: m.created_at });
      }
      lastDay = day;
      const grouped =
        !!prev &&
        !dayChanged && // a day boundary always starts a fresh (avatar) group
        prev.author_id === m.author_id &&
        !m.reply_to &&
        m.created_at - prev.created_at < 5 * 60_000;
      out.push({
        ...m,
        kind: "msg",
        key: m.id,
        grouped,
        reply: replyOf(m),
        mine: m.author_id === me.userId,
        canManage: canManageMessages,
        authorName: m.author_name,
        authorImage: m.author_image,
        authorAccent: m.author_accent,
        reactions: m.reactions ?? [],
      });
      prev = m;
    }
    return out;
  }, [messages, me.userId, canManageMessages]);

  const list = useMugenVirtualizer<Item>({ items });
  listRef.current = list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  loadedIdsRef.current = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) if (it.kind === "msg") s.add(it.id);
    return s;
  }, [items]);

  // Keep the live tail pinned through ANY items change — a new message, but also
  // the reactive query's *second* emission once authors/reactions/emoji resolve
  // (which makes rows taller and was the channel-switch drift). Capture whether
  // we were at the bottom *before* the change; re-assert only then. Because the
  // capture predates the change, this is prepend-safe (loading older history
  // happens while scrolled up → not pinned) and never yanks a reader down.
  const wasPinned = useRef(true);
  wasPinned.current = list.getScrollState().distanceFromBottom <= 24;
  useEffect(() => {
    if (anchor || !wasPinned.current) return;
    const raf = requestAnimationFrame(() => list.scrollToBottom({ behavior: "auto" }));
    return () => cancelAnimationFrame(raf);
  }, [items, anchor, list]);

  // Keep the live tail pinned when the composer (a sibling) grows and shrinks our
  // viewport. Mugen only re-sticks on content growth, not on a viewport-height
  // shrink, so the newest messages would slide behind the taller composer. Re-pin
  // iff the user was already at the bottom — i.e. the distance we just lost is
  // about equal to the height we just lost (a scrolled-up reader stays put).
  const scrollHostRef = useRef<HTMLDivElement>(null);
  const prevHostH = useRef(0);
  // The real media-column width, so embeds reserve a row height that matches how
  // wide they actually render (fixes clipped embeds on narrow / page-zoomed views).
  const [mediaW, setMediaW] = useState(initialMediaW);
  useEffect(() => {
    const el = scrollHostRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    prevHostH.current = el.clientHeight;
    setMediaW(computeMediaW(el.clientWidth));
    const ro = new ResizeObserver(() => {
      const next = computeMediaW(el.clientWidth);
      setMediaW((prev) => (prev !== next ? next : prev));
      const h = el.clientHeight;
      const shrank = prevHostH.current - h;
      prevHostH.current = h;
      if (anchor || shrank <= 0) return;
      if (list.getScrollState().distanceFromBottom <= shrank + 32) {
        requestAnimationFrame(() => list.scrollToBottom({ behavior: "auto" }));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor, list]);

  // Reliably land at the bottom once a channel's first page is ready. Mugen's
  // `initialScroll="bottom"` can apply during the brief empty state and miss,
  // leaving the view at the top. Runs once per mount (the panel is keyed by
  // channel), and never when arriving via a jump anchor.
  const landed = useRef(false);
  useEffect(() => {
    if (anchor) {
      landed.current = true;
      return;
    }
    if (landed.current || result.status !== "ready" || items.length === 0) return;
    landed.current = true;
    return settleToBottom(list);
  }, [anchor, result.status, items.length, list]);

  // After "back to latest" clears the anchor, the live page (re)loads — settle to
  // the bottom once it's ready (clearing the anchor by itself doesn't scroll, so
  // we'd otherwise be left scrolled up with a stuck "Jump to latest").
  useEffect(() => {
    if (anchor || !pendingBottom.current || result.status !== "ready") return;
    pendingBottom.current = false;
    return settleToBottom(list);
  }, [anchor, result.status, list]);

  // After scrolling an anchored (jumped) window all the way back to the live
  // bottom, drop the ?at= anchor so the tail re-engages and the "back to latest"
  // pill disappears instead of lingering. Crucially this must NOT fire while the
  // jump is still landing — clicking a reply *from the bottom* would otherwise
  // clear the anchor before the scroll-to-target runs — so we only clear once the
  // view has actually moved away from the bottom (the jump landed) and returned.
  const atTrueBottom = useMugenSelector(list, (s) => s.distanceFromBottom < 8);
  const movedAway = useRef(false);
  const jumpLanded = useRef(false);
  const anchorRef = useRef(anchor);
  useEffect(() => {
    if (anchorRef.current !== anchor) {
      anchorRef.current = anchor;
      movedAway.current = false; // a fresh anchor (or cleared): start over
    }
    if (!anchor) return;
    if (!atTrueBottom) {
      movedAway.current = true; // the jump scrolled us off the bottom
      return;
    }
    // At the true live bottom: drop the anchor once the jump has resolved —
    // either it landed us right here (the target was already at the bottom) or
    // we scrolled back down after it moved us away. Either way there's nothing
    // newer below, so the live tail should re-engage and the pill disappear.
    if ((movedAway.current || jumpLanded.current) && !result.hasNewer) backToLatest();
  }, [anchor, atTrueBottom, result.hasNewer, backToLatest]);

  const handledAnchor = useRef<string | null>(null);
  useEffect(() => {
    if (!anchor) {
      handledAnchor.current = null;
      jumpLanded.current = false;
      return;
    }
    if (handledAnchor.current === anchor) return;
    if (!items.some((it) => it.kind === "msg" && it.id === anchor)) return;
    handledAnchor.current = anchor;
    jumpLanded.current = false;
    let tries = 25;
    const land = () => {
      list.scrollToItem(anchor, { align: "center" });
      const el = document.getElementById(`msg-${anchor}`);
      if (el) {
        requestAnimationFrame(() => {
          list.scrollToItem(anchor, { align: "center" });
          flashEl(el);
          jumpLanded.current = true; // the jump has reached its target
          // If it landed at the live bottom, drop the anchor right away — the
          // separate auto-clear effect only fires when atTrueBottom *changes*,
          // which it doesn't when we were already at the bottom.
          if (list.getScrollState().distanceFromBottom < 8 && !result.hasNewer) backToLatest();
        });
        return;
      }
      if (tries-- > 0) requestAnimationFrame(land);
    };
    requestAnimationFrame(land);
  }, [anchor, items, list, result.hasNewer, backToLatest]);

  // Loading state drives the edge skeletons (below). A ref is the synchronous
  // dedupe guard (a scroll burst can call the loader several times before any
  // re-render); the mirrored state is what the slots read so they actually
  // re-render the skeleton in/out. Both clear once the next page lands (`items`
  // changes). The top skeleton's appearance/disappearance is scroll-anchored by
  // mugen, so toggling it never jumps the reader.
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  useEffect(() => {
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    setLoadingOlder(false);
    setLoadingNewer(false);
  }, [items]);
  const loadOlder = useCallback(() => {
    if (loadingOlderRef.current || !result.hasOlder) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    result.loadOlder();
  }, [result]);
  const loadNewer = useCallback(() => {
    if (loadingNewerRef.current || !result.hasNewer) return;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    result.loadNewer();
  }, [result]);

  // Markdown inline overrides: render `[@Name](mention:userId)` as a coloured,
  // clickable mention chip; other links stay normal links.
  const mdComponents = useMemo<MarkdownComponents>(
    () =>
      defineMarkdownComponents({
        inline: {
          // Render unicode emoji at the same square as custom emoji, so a message
          // mixing both reads uniformly. Plain text falls through untouched.
          text: (node, ctx) => {
            const value = node.value;
            if (!value) return null;
            const segs = splitEmoji(value);
            if (segs.length === 1 && "text" in segs[0]) return null; // no emoji → default
            const fmt = ctx.fmt;
            const textRun = (text: string): RichTextRun => {
              const run: RichTextRun = { text, font: ctx.font() };
              if (fmt.color != null) run.color = fmt.color;
              if (fmt.background != null) run.background = fmt.background;
              const decoration = [fmt.underline ? "underline" : "", fmt.strike ? "line-through" : ""].filter(Boolean).join(" ");
              if (decoration) run.decoration = decoration;
              if (fmt.href != null) {
                run.href = fmt.href;
                run.as = "a";
              } else if (fmt.mono) {
                run.as = "code";
              }
              return run;
            };
            return segs.map((s): RichTextRun =>
              "text" in s
                ? textRun(s.text)
                : { advance: EMOJI_SIZE + EMOJI_PAD, content: <span style={unicodeEmojiStyle}>{s.emoji}</span> },
            );
          },
          link: (node) => {
            const label = linkLabel(node);
            if (node.url.startsWith("mention:")) {
              const uid = node.url.slice("mention:".length);
              // Inline box painting the exact same chip as the composer input.
              return [
                {
                  advance: Math.ceil(measureInline(label, MENTION_FONT)) + MENTION_PAD,
                  content: (
                    <span style={{ ...mentionChipStyle, cursor: "pointer" }} onClick={() => memberCard.open(uid)}>
                      {label}
                    </span>
                  ),
                },
              ];
            }
            if (node.url.startsWith("emoji:")) {
              // `[:name:](emoji:id)` → the custom emoji image, sized like the
              // composer atom. Falls back to the `:name:` text if it's gone.
              const url = emojiUrlById.get(node.url.slice("emoji:".length));
              if (!url) return [{ text: label }];
              return [
                {
                  advance: EMOJI_SIZE + EMOJI_PAD,
                  content: (
                    <span style={{ display: "inline-flex", width: "100%", alignItems: "center", justifyContent: "center" }}>
                      <img src={url} alt={label} style={customEmojiImgStyle} referrerPolicy="no-referrer" draggable={false} />
                    </span>
                  ),
                },
              ];
            }
            return [{ text: label, color: "var(--primary)", decoration: "underline", href: node.url }];
          },
        },
      }),
    [memberCard.open, emojiUrlById],
  );

  const render = useCallback(
    (it: Item): ReactNode =>
      it.kind === "day" ? (
        <DayDivider ms={it.ms} />
      ) : (
        <MessageRow
          m={it}
          onReply={onReply}
          onJump={jumpTo}
          onEdit={onEdit}
          onDelete={onDelete}
          onOpenProfile={memberCard.open}
          roleColorOf={memberCard.roleColorOf}
          mdComponents={mdComponents}
          emojiUrlById={emojiUrlById}
          onReact={onReact}
          onToggleReaction={onToggleReaction}
          onReactionContext={onReactionContext}
          onContext={(e) => openMenu(e, messageMenu(it, { onReply, onEdit, onDelete }))}
          mediaW={mediaW}
        />
      ),
    [onReply, jumpTo, onEdit, onDelete, openMenu, memberCard.open, memberCard.roleColorOf, mdComponents, emojiUrlById, onReact, onToggleReaction, onReactionContext, mediaW],
  );

  // Top edge: a tall skeleton page during the very first load; a short skeleton
  // only while actively fetching older history; the channel-start cap once the
  // top is genuinely reached; otherwise nothing (idle with more above — no
  // perpetual shimmer). renderBottom mirrors it for newer history, but only
  // ever shows while loading: the live tail has no "end of channel" cap.
  const renderTop = useCallback(
    () =>
      result.status !== "ready" ? (
        <Escape height={380}>
          <MessageSkeletons count={6} />
        </Escape>
      ) : loadingOlder ? (
        <Escape height={144}>
          <MessageSkeletons count={2} />
        </Escape>
      ) : result.hasOlder ? null : (
        <ChannelStart name={channelName} />
      ),
    [result.status, result.hasOlder, loadingOlder, channelName],
  );
  const renderBottom = useCallback(
    () =>
      loadingNewer ? (
        <Escape height={144}>
          <MessageSkeletons count={2} />
        </Escape>
      ) : null,
    [loadingNewer],
  );

  return (
    <div ref={scrollHostRef} className="relative min-h-0 flex-1">
      <MugenVList
        instance={list}
        getKey={(it) => it.key}
        render={render}
        renderTop={renderTop}
        renderBottom={renderBottom}
        font={BODY_FONT}
        lineHeight={BODY_LH}
        whiteSpace="pre-wrap"
        overscan={600}
        initialScroll={anchor ? undefined : "bottom"}
        stickToBottom={anchor ? false : { behavior: "instant" }}
        onTopReached={loadOlder}
        onBottomReached={loadNewer}
        topReachedThreshold={600}
        bottomReachedThreshold={300}
        className="rb-scroll h-full"
      />
      <JumpToLatest list={list} anchored={result.isAnchored} hasNewer={result.hasNewer} onBack={backToLatest} />
      {orbitId && (
        <EmojiPicker
          open={!!reactionFor}
          orbitId={orbitId}
          anchorEl={reactionFor?.anchor ?? null}
          onPick={(p) => reactionFor && onToggleReaction(reactionFor.id, reactionValue(p))}
          onClose={() => setReactionFor(null)}
        />
      )}
      {confirmDialog}
    </div>
  );
}

// Pulsing placeholder rows shown while messages load — on first paint and when
// fetching older history via infinite scroll.
function MessageSkeletons({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-6 px-4 py-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ChannelStart({ name }: { name?: string }) {
  return (
    <VStack padding={0}>
      <Escape height={120}>
        <div className="flex h-full flex-col justify-end gap-1.5 px-4 pb-3 pt-6">
          <h2 className="text-[28px] font-bold leading-tight tracking-tight">
            Welcome to {name ? `#${name}` : "the channel"}
          </h2>
          <p className="text-sm text-muted-foreground">
            This is the very beginning of {name ? `#${name}` : "this channel"}.
          </p>
        </div>
      </Escape>
    </VStack>
  );
}

function JumpToLatest({
  list,
  anchored,
  hasNewer,
  onBack,
}: {
  list: MugenInstance<Item>;
  anchored: boolean;
  hasNewer: boolean;
  onBack: () => void;
}) {
  const away = useMugenSelector(list, (s) => s.distanceFromBottom > 240);
  const atBottom = useMugenSelector(list, (s) => s.distanceFromBottom < 8);
  // Genuinely at the live tail (bottom, nothing newer to load) → never show,
  // even while an anchor lingers from a reply jump that landed at the bottom.
  if (atBottom && !hasNewer) return null;
  if (!away && !anchored) return null;
  return (
    <Button
      size="sm"
      className="surface-float absolute bottom-4 left-1/2 -translate-x-1/2 gap-1.5 rounded-full bg-primary text-primary-foreground hover:bg-primary-hover"
      onClick={() => (anchored ? onBack() : list.scrollToBottom({ behavior: "smooth" }))}
    >
      <ArrowDown className="size-3.5" />
      {anchored ? "Back to latest" : "Jump to latest"}
    </Button>
  );
}

/** The right-click menu for a message (mirrors the hover toolbar). */
function messageMenu(
  m: MsgItem,
  h: { onReply: (m: ReplyTarget) => void; onEdit: (m: EditTarget) => void; onDelete: (id: string) => void },
): MenuItem[] {
  const items: MenuItem[] = [
    { label: "Reply", icon: <Reply />, onSelect: () => h.onReply({ id: m.id, author_name: m.authorName, body: m.body }) },
    { label: "Copy text", icon: <Copy />, onSelect: () => navigator.clipboard?.writeText(humanizeBody(m.body)) },
  ];
  if (m.mine) {
    items.push({ label: "Edit message", icon: <Pencil />, onSelect: () => h.onEdit({ id: m.id, body: m.body }) });
  }
  if (m.mine || m.canManage) {
    items.push({ type: "separator" });
    items.push({ label: "Delete message", icon: <Trash2 />, destructive: true, onSelect: () => h.onDelete(m.id) });
  }
  return items;
}

interface RowProps {
  m: MsgItem;
  onReply: (m: ReplyTarget) => void;
  onJump: (id: string) => void;
  onEdit: (m: EditTarget) => void;
  onDelete: (id: string) => void;
  onOpenProfile: (userId: string) => void;
  roleColorOf: (userId: string) => string | undefined;
  mdComponents: MarkdownComponents;
  emojiUrlById: Map<string, string>;
  onReact: (id: string, anchor: HTMLElement) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onReactionContext: (e: ReactMouseEvent, r: ReactionAgg) => void;
  onContext: (e: ReactMouseEvent) => void;
  mediaW: number;
}

function MessageRow({ m, onReply, onJump, onEdit, onDelete, onOpenProfile, roleColorOf, mdComponents, emojiUrlById, onReact, onToggleReaction, onReactionContext, onContext, mediaW }: RowProps) {
  const openAuthor = (e?: ReactMouseEvent) => {
    e?.stopPropagation(); // don't also toggle the row's action toolbar
    onOpenProfile(m.author_id);
  };
  const topGap = m.grouped ? 8 : 16;
  const showDelete = m.mine || m.canManage;
  // Touch: press-and-hold anywhere on the message reveals its action toolbar —
  // so the (otherwise invisible) actions aren't pressed by accident, and a quick
  // tap on the avatar/username/a link still does its own thing. A long press
  // suppresses that trailing tap. Tap elsewhere or scroll to dismiss. Desktop
  // uses hover and keeps the right-click menu.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const didLongPress = useRef(false);
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const onTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    pressStart.current = { x: t.clientX, y: t.clientY };
    didLongPress.current = false;
    cancelPress();
    const row = e.currentTarget as HTMLElement;
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      didLongPress.current = true;
      revealMessageActions(row);
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    const s = pressStart.current;
    if (!s) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10) cancelPress();
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    cancelPress();
    if (didLongPress.current) e.preventDefault(); // swallow the click so links/profile don't fire
  };
  return (
    <VStack
      id={`msg-${m.id}`}
      padding={0}
      className="rb-row group"
      // Desktop right-click opens the menu; on touch the native long-press menu
      // is suppressed in favour of the toolbar reveal above.
      onContextMenu={IS_TOUCH ? (e: ReactMouseEvent) => e.preventDefault() : onContext}
      onTouchStart={IS_TOUCH ? onTouchStart : undefined}
      onTouchMove={IS_TOUCH ? onTouchMove : undefined}
      onTouchEnd={IS_TOUCH ? onTouchEnd : undefined}
    >
      <Portal container={null}>
        <div className="rb-row-bg" />
      </Portal>

      <Portal container={null}>
        <div
          className={cn(
            "msg-actions menu-surface z-10 flex items-center gap-0.5 rounded-xl p-0.5 transition-opacity",
            // Hidden + non-interactive by default (so invisible buttons can't be
            // tapped by accident). Desktop reveals on hover; touch reveals on tap
            // (the .rb-row.show-actions CSS rule, toggled in onRowClick).
            "opacity-0 pointer-events-none",
            "focus-within:opacity-100 focus-within:pointer-events-auto group-hover:opacity-100 group-hover:pointer-events-auto",
          )}
          // The toolbar's vertical center sits on the *top edge of the hover
          // highlight* (the `.rb-row-bg`, inset -4px above the row top), so it
          // straddles the top of the highlighted message — half above, half on
          // it. (translateY centers it regardless of the toolbar's own height.)
          style={{ position: "absolute", top: -4, right: 12, transform: "translateY(-50%)" }}
        >
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              aria-label={`React ${e}`}
              title={`React ${e}`}
              onClick={() => onToggleReaction(m.id, e)}
              className="grid size-7 place-items-center rounded-md text-[18px] leading-none transition-[transform,background-color] hover:scale-110 hover:bg-accent active:scale-95"
            >
              {e}
            </button>
          ))}
          <IconAction label="React" onClick={(e) => onReact(m.id, e.currentTarget as HTMLElement)}>
            <SmilePlus />
          </IconAction>
          <span className="mx-0.5 h-5 w-px bg-border-strong" />
          <IconAction label="Reply" onClick={() => onReply({ id: m.id, author_name: m.authorName, body: m.body })}>
            <Reply />
          </IconAction>
          {m.mine && (
            <IconAction label="Edit" onClick={() => onEdit({ id: m.id, body: m.body })}>
              <Pencil />
            </IconAction>
          )}
          {showDelete && (
            <IconAction label="Delete" onClick={() => onDelete(m.id)}>
              <Trash2 />
            </IconAction>
          )}
        </div>
      </Portal>

      <VStack width={1} height={topGap} />

      {m.reply.status !== "none" && <ReplyQuote info={m.reply} parentId={m.reply_to} onJump={onJump} />}

      <HStack gap={0} align="start">
        <VStack width={LEFT} height={1} />

        {m.grouped ? (
          <VStack width={AV} align="end" justify="start">
            <Text
              font="11px Geist"
              lineHeight={22}
              color={FAINT}
              className="msg-time opacity-0 transition-opacity group-hover:opacity-100"
            >
              {shortTime(m.created_at)}
            </Text>
          </VStack>
        ) : (
          <Escape width={AV} height={AV}>
            {m.authorImage ? (
              <img
                src={m.authorImage}
                alt=""
                referrerPolicy="no-referrer"
                onClick={openAuthor}
                className="size-full cursor-pointer rounded-full object-cover"
                style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)" }}
              />
            ) : (
              <span
                onClick={openAuthor}
                className="grid size-full cursor-pointer place-items-center rounded-full text-[12px] font-semibold text-white/95"
                style={{
                  background: userColor(m.authorAccent, m.authorName),
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)",
                }}
              >
                {initials(m.authorName)}
              </span>
            )}
          </Escape>
        )}

        <VStack width={GAP} height={1} />

        <VStack gap={2}>
          {!m.grouped && (
            <Escape height={22}>
              <div className="flex items-baseline gap-2">
                <span
                  onClick={openAuthor}
                  style={roleColorOf(m.author_id) ? { color: roleColorOf(m.author_id) } : undefined}
                  className="cursor-pointer text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground hover:underline"
                >
                  {m.authorName}
                </span>
                <span className="text-[12px] font-medium leading-5 text-faint">
                  {formatTime(m.created_at)}
                </span>
              </div>
            </Escape>
          )}

          {m.body ? <Markdown source={m.body} theme={MD_THEME} components={mdComponents} /> : null}
          <MessageMedia attachments={m.attachments} embeds={m.embeds} maxW={mediaW} />
          {m.edited && (
            <Text font="11px Geist" lineHeight={14} color={FAINT}>
              (edited)
            </Text>
          )}
          {m.reactions.length > 0 && (
            <Escape height={36}>
              <div className="no-scrollbar flex h-full items-center gap-1 overflow-x-auto">
                {m.reactions.map((r) => {
                  const cid = customIdOf(r.emoji);
                  return (
                    <ReactionPill
                      key={r.emoji}
                      r={r}
                      url={cid ? emojiUrlById.get(cid) : undefined}
                      onClick={() => onToggleReaction(m.id, r.emoji)}
                      onContextMenu={(e) => onReactionContext(e, r)}
                    />
                  );
                })}
                <button
                  type="button"
                  aria-label="Add reaction"
                  onClick={(e) => onReact(m.id, e.currentTarget)}
                  className="grid size-[28px] shrink-0 place-items-center rounded-full border border-border-strong bg-raised text-muted-foreground transition-colors hover:bg-elevated hover:text-foreground"
                >
                  <SmilePlus className="size-4" />
                </button>
              </div>
            </Escape>
          )}
        </VStack>

        <VStack width={RIGHT} height={1} />
      </HStack>
    </VStack>
  );
}

function DayDivider({ ms }: { ms: number }) {
  return (
    <VStack padding={0}>
      <Escape height={48}>
        <div className="flex h-full items-center gap-3 px-4">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-border" />
          <span className="day-chip rounded-full px-3.5 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
            {dayLabel(ms)}
          </span>
          <div className="h-px flex-1 bg-gradient-to-l from-transparent via-border to-border" />
        </div>
      </Escape>
    </VStack>
  );
}

function ReplyQuote({
  info,
  parentId,
  onJump,
}: {
  info: Exclude<ReplyInfo, { status: "none" }>;
  parentId: string | null;
  onJump: (id: string) => void;
}) {
  const snippet =
    info.status === "ok" ? bodyPreview(info.body).slice(0, 200) : "";
  return (
    <Escape height={20}>
      <div
        data-replyjump={parentId ?? undefined}
        onClick={() => parentId && onJump(parentId)}
        className="rb-reply flex h-full cursor-pointer select-none items-center gap-1.5 pl-16 pr-6 text-[13px]"
      >
        <span className="shrink-0 text-faint">Replying to</span>
        {info.status === "deleted" ? (
          <span className="italic text-muted-foreground/70">a deleted message</span>
        ) : (
          <>
            {info.image ? (
              <img
                src={info.image}
                alt=""
                referrerPolicy="no-referrer"
                className="size-4 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span
                className="grid size-4 shrink-0 place-items-center rounded-full text-[8px] font-semibold leading-none text-white/90"
                style={{ background: userColor(info.accent, info.author) }}
              >
                {initials(info.author)}
              </span>
            )}
            <span className="shrink-0 font-semibold text-foreground/80">{info.author}</span>
            <span className="min-w-0 truncate text-muted-foreground">{snippet}</span>
          </>
        )}
      </div>
    </Escape>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (e: ReactMouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A reaction chip: the emoji (unicode or custom image) + its count, lit up when
 *  the current user is one of the reactors. Click toggles your reaction;
 *  right-click shows who reacted. */
function ReactionPill({
  r,
  url,
  onClick,
  onContextMenu,
}: {
  r: ReactionAgg;
  url?: string;
  onClick: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const missingCustom = !url && customIdOf(r.emoji) !== null;
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        "flex h-[28px] shrink-0 items-center gap-1 rounded-full border px-2 text-[12.5px] font-medium tabular-nums transition-colors",
        r.mine
          ? "border-primary/55 bg-primary/15 text-foreground"
          : "border-border-strong bg-raised text-muted-foreground hover:bg-elevated hover:text-foreground",
      )}
    >
      {url ? (
        <img src={url} alt="" className="size-[20px] object-contain" referrerPolicy="no-referrer" />
      ) : (
        <span className="text-[17px] leading-none">{missingCustom ? "❔" : r.emoji}</span>
      )}
      <span>{r.count}</span>
    </button>
  );
}

function flashEl(el: HTMLElement) {
  el.classList.remove("jump-flash");
  void el.offsetWidth;
  el.classList.add("jump-flash");
}

/** Re-pin to the bottom every frame until the content height has *settled* —
 *  Mugen measures rows lazily, so a freshly-opened channel's total height keeps
 *  growing for a bit and the "true" bottom drifts down. Stop once totalHeight
 *  has been stable for several frames (measurement done), or after a hard cap.
 *  Re-pinning every frame means each growth is followed, so we never end up a
 *  little (or a lot) above the bottom. Returns a cleanup. */
function settleToBottom(list: MugenInstance<Item>): () => void {
  // Re-pin every frame for a window long enough to outlast Mugen's lazy,
  // bursty-with-lulls row measurement (a stability check stops too early on a
  // lull). Bail the moment the user actually scrolls up — a clear distance jump
  // with no content growth — so we never fight a reader.
  let raf = 0;
  let frames = 0;
  let baseline = list.getScrollState().distanceFromBottom;
  let lastTotal = list.getScrollState().totalHeight;
  const CAP = 50; // ~0.8s
  const tick = () => {
    const s = list.getScrollState();
    const grew = s.totalHeight - lastTotal;
    lastTotal = s.totalHeight;
    if (frames > 3 && s.distanceFromBottom - baseline > 24 && grew <= 2) return; // user scrolled up
    list.scrollToBottom({ behavior: "auto" });
    baseline = list.getScrollState().distanceFromBottom; // re-baseline after pinning
    if (++frames < CAP) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
