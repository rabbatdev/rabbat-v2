import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@rabbat/react";
import { Search, Sparkles } from "lucide-react";

import { api, type AvailableEmoji as AvailEmoji } from "@/rabbat";
import { EMOJI_CATEGORIES, searchEmoji } from "@/lib/emoji-data";
import type { EmojiPick } from "@/lib/emoji";
import { useAnimatedOpen } from "@/components/ui/use-animated-open";
import { cn } from "@/lib/utils";

const W = 340;
const H = 392;

/** A floating emoji picker: custom emoji from every orbit you're in (grouped by
 *  server) plus a curated unicode set, with search. Positions itself above the
 *  anchor — flipping below when cramped — and closes on click-outside / Escape.
 *  Reused by the composer and reactions. */
export function EmojiPicker({
  open = true,
  orbitId,
  anchorEl,
  onPick,
  onClose,
  closeOnPick = true,
}: {
  open?: boolean;
  orbitId: string;
  anchorEl: HTMLElement | null;
  onPick: (pick: EmojiPick) => void;
  onClose: () => void;
  closeOnPick?: boolean;
}) {
  const { render, state } = useAnimatedOpen(open, 150);
  const available = useQuery(api.emoji.available, {}) ?? [];
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sections = useRef<Record<string, HTMLDivElement | null>>({});
  const [pos, setPos] = useState<{ top: number; left: number; origin: string } | null>(null);

  // Group custom emoji by their source orbit, current orbit first.
  const customGroups = useMemo(() => {
    const byOrbit = new Map<string, { orbitId: string; orbitName: string; emojis: AvailEmoji[] }>();
    for (const e of available) {
      let g = byOrbit.get(e.orbit_id);
      if (!g) byOrbit.set(e.orbit_id, (g = { orbitId: e.orbit_id, orbitName: e.orbit_name, emojis: [] }));
      g.emojis.push(e);
    }
    return [...byOrbit.values()].sort((a, b) =>
      a.orbitId === orbitId ? -1 : b.orbitId === orbitId ? 1 : a.orbitName.localeCompare(b.orbitName),
    );
  }, [available, orbitId]);
  const hasCustom = customGroups.length > 0;

  useLayoutEffect(() => {
    const place = () => {
      const r = anchorEl?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.min(Math.max(8, r.right - W), vw - W - 8);
      const above = r.top > H + 12;
      const top = above ? r.top - H - 8 : Math.min(r.bottom + 8, vh - H - 8);
      // Grow from the edge nearest the anchor (the emoji/react button).
      setPos({ top: Math.max(8, top), left, origin: above ? "bottom right" : "top right" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorEl]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorEl?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, anchorEl, onClose]);

  const unicodeResults = useMemo(() => searchEmoji(query), [query]);
  const customResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return available.filter((e) => e.name.includes(q)).slice(0, 24);
  }, [query, available]);
  const searching = query.trim().length > 0;

  const pick = (p: EmojiPick) => {
    onPick(p);
    if (closeOnPick) onClose();
  };
  // offsetTop is relative to the scroll container (it's `relative`), so this
  // lands the section's header flush at the top of the scroll viewport.
  const scrollTo = (key: string) => {
    const el = sections.current[key];
    const s = scrollRef.current;
    if (el && s) s.scrollTo({ top: el.offsetTop, behavior: "auto" });
  };

  if (!render || !pos) return null;
  return createPortal(
    <div
      ref={panelRef}
      data-ori-overlay
      data-anim="popover"
      data-state={state}
      className={cn(
        "menu-surface fixed z-[80] flex flex-col overflow-hidden",
        state === "closed" && "pointer-events-none",
      )}
      style={{ top: pos.top, left: pos.left, width: W, height: H, transformOrigin: pos.origin }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji"
          // 16px on mobile so iOS doesn't zoom on focus; 13.5px on desktop.
          className="w-full bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground sm:text-[13.5px]"
        />
      </div>

      {!searching && (
        <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 py-1">
          {hasCustom && (
            <button
              type="button"
              onClick={() => scrollTo(`custom:${customGroups[0].orbitId}`)}
              title="Custom"
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <Sparkles className="size-4" />
            </button>
          )}
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => scrollTo(c.key)}
              title={c.label}
              className="grid size-7 place-items-center rounded-md text-[15px] leading-none transition-colors hover:bg-white/[0.06]"
            >
              {c.icon}
            </button>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="no-scrollbar relative flex-1 overflow-y-auto px-2 pb-2">
        {searching ? (
          unicodeResults.length || customResults.length ? (
            <Section label="Results" refCb={() => {}}>
              <Grid>
                {customResults.map((e) => (
                  <CustomBtn key={e.id} emoji={e} onClick={() => pick({ type: "custom", id: e.id, name: e.name, url: e.url })} />
                ))}
                {unicodeResults.map((e, i) => (
                  <EmojiBtn key={`${e.char}-${i}`} char={e.char} title={e.keywords} onClick={() => pick({ type: "unicode", char: e.char })} />
                ))}
              </Grid>
            </Section>
          ) : (
            <p className="px-1 py-8 text-center text-[13px] text-muted-foreground">No emoji found for “{query}”.</p>
          )
        ) : (
          <>
            {customGroups.map((g) => (
              <Section key={g.orbitId} label={g.orbitName} refCb={(el) => (sections.current[`custom:${g.orbitId}`] = el)}>
                <Grid>
                  {g.emojis.map((e) => (
                    <CustomBtn key={e.id} emoji={e} onClick={() => pick({ type: "custom", id: e.id, name: e.name, url: e.url })} />
                  ))}
                </Grid>
              </Section>
            ))}
            {EMOJI_CATEGORIES.map((cat) => (
              <Section key={cat.key} label={cat.label} refCb={(el) => (sections.current[cat.key] = el)}>
                <Grid>
                  {cat.emojis.map(([char, kw], i) => (
                    <EmojiBtn key={`${char}-${i}`} char={char} title={kw} onClick={() => pick({ type: "unicode", char })} />
                  ))}
                </Grid>
              </Section>
            ))}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-8 gap-0.5 px-1">{children}</div>;
}

// Opaque, full-bleed sticky header so emoji scroll cleanly beneath it.
function Section({ label, refCb, children }: { label: string; refCb: (el: HTMLDivElement | null) => void; children: ReactNode }) {
  return (
    <div ref={refCb} className="pt-1">
      <h4 className="sticky top-0 z-10 -mx-2 mb-0.5 truncate border-b border-border bg-[var(--menu-bg)] px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
        {label}
      </h4>
      {children}
    </div>
  );
}

function EmojiBtn({ char, title, onClick }: { char: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-md text-[20px] leading-none transition-colors hover:bg-white/[0.06]"
    >
      {char}
    </button>
  );
}

function CustomBtn({ emoji, onClick }: { emoji: AvailEmoji; onClick: () => void }) {
  return (
    <button
      type="button"
      title={`:${emoji.name}:`}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-md transition-colors hover:bg-white/[0.06]"
    >
      <img src={emoji.url} alt={`:${emoji.name}:`} className="size-[22px] object-contain" referrerPolicy="no-referrer" />
    </button>
  );
}
