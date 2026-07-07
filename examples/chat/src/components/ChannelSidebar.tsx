import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useRouter, useParams } from "@rabbat/react";
import { useMutation, useQuery } from "@rabbat/react";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hash,
  Link2,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Settings,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";

import { api, type Category, type Channel, type Role as EditRole } from "@/rabbat";
import { useOrbit } from "@/context/orbit-context";
import { useMobileNav } from "@/context/mobile-nav";
import { Perm, hasPerm } from "@/lib/perms";
import { errorMessage, roleTint } from "@/lib/util";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "./ConfirmDialog";
import { useContextMenu, type MenuItem } from "@/components/ui/context-menu";
import { InvitePeopleModal } from "./InviteManager";
import { MorphIndicatorGroup, MorphIndicatorItem } from "@/components/ui/morph-indicator";
import { useAnimatedOpen } from "@/components/ui/use-animated-open";
import { cn } from "@/lib/utils";
import { getLastChannel } from "@/lib/last-location";

/** The sidebar's channel layout: loose (uncategorized) channels + categories. */
type Grouped = { uncategorized: Channel[]; cats: { cat: Category; channels: Channel[] }[] };

/** What the in-flight drag would drop onto — drives the insertion indicators.
 *  `channel`: insert at `index` within group `catId` (null = uncategorized).
 *  `category`: insert at `index` among the categories. */
type DropTarget =
  | { kind: "channel"; catId: string | null; index: number }
  | { kind: "category"; index: number };

const arraysEqual = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function ChannelSidebar({ orbitId }: { orbitId: string }) {
  const orbit = useOrbit();
  const router = useRouter();
  const { leftOpen } = useMobileNav();
  const params = useParams<{ channelId?: string }>();
  const categories = useQuery(api.categories.list, { orbitId });
  const channels = useQuery(api.channels.list, { orbitId });
  const unread = useQuery(api.readState.unread, { orbitId });

  const canManage = hasPerm(orbit, Perm.MANAGE_CHANNELS);
  const canInvite = hasPerm(orbit, Perm.CREATE_INVITE);
  const canSettings = hasPerm(orbit, Perm.MANAGE_ORBIT) || hasPerm(orbit, Perm.MANAGE_ROLES);
  const [menuOpen, setMenuOpen] = useState(false);
  const orbitMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [createIn, setCreateIn] = useState<string | null | undefined>(undefined); // categoryId | null(uncat) | undefined(closed)
  const [createCat, setCreateCat] = useState(false);
  const [editChannel, setEditChannel] = useState<Channel | null>(null);
  const [editCategory, setEditCategory] = useState<Category | null>(null);
  // Drag-and-drop reordering (managers only). `drag` is the item being dragged,
  // `over` the live drop indicator, `optimistic` an instant local rearrangement
  // shown until the live queries catch up.
  const [drag, setDrag] = useState<{ kind: "channel" | "category"; id: string } | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [optimistic, setOptimistic] = useState<Grouped | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const openMenu = useContextMenu();
  const leave = useMutation(api.orbits.leave);
  const removeOrbit = useMutation(api.orbits.remove);
  const removeChannel = useMutation(api.channels.remove);
  const removeCategory = useMutation(api.categories.remove);
  const reorderChannels = useMutation(api.channels.reorder);
  const reorderCategories = useMutation(api.categories.reorder);

  // Auto-open a channel when none is selected — the one you last had open in
  // this orbit (if it still exists), otherwise the first.
  useEffect(() => {
    if (!params.channelId && channels && channels.length > 0) {
      const last = getLastChannel(orbitId);
      const channelId = last && channels.some((c) => c.id === last) ? last : channels[0].id;
      void router.visit(`/o/${orbitId}/c/${channelId}`, { clientOnly: true });
    }
  }, [params.channelId, channels, orbitId, router]);

  const grouped = useMemo(() => {
    const cats = (categories ?? []).slice().sort((a, b) => a.position - b.position);
    const chans = channels ?? [];
    const uncategorized = chans.filter((c) => !c.category_id);
    return {
      uncategorized,
      cats: cats.map((cat) => ({ cat, channels: chans.filter((c) => c.category_id === cat.id) })),
    };
  }, [categories, channels]);

  // Render the optimistic arrangement while a drop is in flight, then fall back
  // to live data the moment it changes (which is when our reorder lands).
  const view = optimistic ?? grouped;
  useEffect(() => {
    setOptimistic(null);
  }, [categories, channels]);

  const resetDrag = () => {
    setDrag(null);
    setOver(null);
  };
  const chansIn = (g: Grouped, catId: string | null) =>
    catId === null ? g.uncategorized : g.cats.find((c) => c.cat.id === catId)?.channels ?? [];
  const allChans = (g: Grouped) => [...g.uncategorized, ...g.cats.flatMap((c) => c.channels)];

  // Move a channel into `catId` at the visual gap `gapIndex` of that group.
  async function dropChannel(catId: string | null, gapIndex: number) {
    if (drag?.kind !== "channel") return resetDrag();
    const id = drag.id;
    const rendered = chansIn(view, catId).map((c) => c.id);
    const without = rendered.filter((x) => x !== id);
    const cur = rendered.indexOf(id);
    let at = gapIndex - (cur !== -1 && cur < gapIndex ? 1 : 0);
    at = Math.max(0, Math.min(at, without.length));
    const orderedIds = [...without.slice(0, at), id, ...without.slice(at)];

    const dragged = allChans(view).find((c) => c.id === id);
    if ((dragged?.category_id ?? null) === catId && arraysEqual(orderedIds, rendered)) return resetDrag();

    const map = new Map(allChans(view).map((c) => [c.id, c] as const));
    const place = (target: string | null): Channel[] =>
      target === catId
        ? orderedIds.map((x) => ({ ...(map.get(x) as Channel), category_id: catId }))
        : chansIn(view, target).filter((c) => c.id !== id);
    setOptimistic({
      uncategorized: place(null),
      cats: view.cats.map((c) => ({ cat: c.cat, channels: place(c.cat.id) })),
    });
    resetDrag();
    try {
      await reorderChannels({ channelId: id, categoryId: catId ?? undefined, orderedIds });
    } catch {
      setOptimistic(null);
    }
  }

  // Move a category to the visual gap `gapIndex` among the categories.
  async function dropCategory(gapIndex: number) {
    if (drag?.kind !== "category") return resetDrag();
    const id = drag.id;
    const ids = view.cats.map((c) => c.cat.id);
    const without = ids.filter((x) => x !== id);
    const cur = ids.indexOf(id);
    let at = gapIndex - (cur !== -1 && cur < gapIndex ? 1 : 0);
    at = Math.max(0, Math.min(at, without.length));
    const orderedIds = [...without.slice(0, at), id, ...without.slice(at)];
    if (arraysEqual(orderedIds, ids)) return resetDrag();
    const map = new Map(view.cats.map((c) => [c.cat.id, c] as const));
    setOptimistic({ uncategorized: view.uncategorized, cats: orderedIds.map((x) => map.get(x)!) });
    resetDrag();
    try {
      await reorderCategories({ orbitId, orderedIds });
    } catch {
      setOptimistic(null);
    }
  }

  const half = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2 ? 1 : 0;
  };
  // Channel drag sources / targets.
  function startChannelDrag(e: React.DragEvent, id: string) {
    if (!canManage) return;
    e.stopPropagation(); // don't also start the enclosing category's drag
    setDrag({ kind: "channel", id });
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }
  function chanOver(e: React.DragEvent, catId: string | null, i: number) {
    if (drag?.kind !== "channel") return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setOver({ kind: "channel", catId, index: i + half(e) });
  }
  function chanDrop(e: React.DragEvent, catId: string | null, i: number) {
    if (drag?.kind !== "channel") return;
    e.preventDefault();
    e.stopPropagation();
    void dropChannel(catId, i + half(e));
  }
  // Drop into a group's empty space / past its last row.
  function groupOver(e: React.DragEvent, catId: string | null, end: number) {
    if (drag?.kind !== "channel") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver({ kind: "channel", catId, index: end });
  }
  function groupDrop(e: React.DragEvent, catId: string | null, end: number) {
    if (drag?.kind !== "channel") return;
    e.preventDefault();
    void dropChannel(catId, end);
  }
  // Category drag source (whole block) + channel-into-category target (header).
  function startCategoryDrag(e: React.DragEvent, id: string) {
    if (!canManage) return;
    setDrag({ kind: "category", id });
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }
  function headerOver(e: React.DragEvent, catId: string) {
    if (drag?.kind !== "channel") return; // category reorder handled by the block
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setOver({ kind: "channel", catId, index: 0 });
  }
  function headerDrop(e: React.DragEvent, catId: string) {
    if (drag?.kind !== "channel") return;
    e.preventDefault();
    e.stopPropagation();
    void dropChannel(catId, 0);
  }
  function catAreaOver(e: React.DragEvent, i: number) {
    if (drag?.kind !== "category") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver({ kind: "category", index: i + half(e) });
  }
  function catAreaDrop(e: React.DragEvent, i: number) {
    if (drag?.kind !== "category") return;
    e.preventDefault();
    void dropCategory(i + half(e));
  }
  const chanLineAt = (catId: string | null, i: number) =>
    over?.kind === "channel" && over.catId === catId && over.index === i;
  const catLineAt = (i: number) => over?.kind === "category" && over.index === i;

  // A channel row (index `i` within group `catId`) with its drop line above it.
  const renderChannel = (ch: Channel, catId: string | null, i: number) => (
    <Fragment key={ch.id}>
      {chanLineAt(catId, i) && <DropLine />}
      <MorphIndicatorItem id={ch.id} className="w-full">
        <ChannelRow
          orbitId={orbitId}
          channel={ch}
          active={ch.id === params.channelId}
          unread={!!unread?.[ch.id]?.unread}
          onContext={(e) => openMenu(e, channelMenu(ch))}
          draggable={canManage}
          dimmed={drag?.kind === "channel" && drag.id === ch.id}
          onDragStart={(e) => startChannelDrag(e, ch.id)}
          onDragEnd={resetDrag}
          onDragOver={(e) => chanOver(e, catId, i)}
          onDrop={(e) => chanDrop(e, catId, i)}
        />
      </MorphIndicatorItem>
    </Fragment>
  );

  async function onLeave() {
    if (await confirm({ title: `Leave ${orbit?.name}?`, description: "You'll need an invite to rejoin.", confirmLabel: "Leave", destructive: true })) {
      await leave({ orbitId });
      void router.visit("/");
    }
  }
  async function onDelete() {
    if (await confirm({ title: `Delete ${orbit?.name}?`, description: "This permanently removes the orbit and all its channels and messages.", confirmLabel: "Delete orbit", destructive: true })) {
      await removeOrbit({ orbitId });
      void router.visit("/");
    }
  }

  function channelMenu(ch: Channel): MenuItem[] {
    const items: MenuItem[] = [
      { type: "label", label: `#${ch.name}` },
      {
        label: "Copy link",
        icon: <Link2 />,
        onSelect: () => navigator.clipboard?.writeText(`${location.origin}/o/${orbitId}/c/${ch.id}`),
      },
    ];
    if (canManage) {
      items.push({ type: "separator" });
      items.push({ label: "Edit channel", icon: <Pencil />, onSelect: () => setEditChannel(ch) });
      items.push({
        label: "Delete channel",
        icon: <Trash2 />,
        destructive: true,
        onSelect: () => void deleteChannel(ch),
      });
    }
    return items;
  }
  async function deleteChannel(ch: Channel) {
    if (
      await confirm({
        title: `Delete #${ch.name}?`,
        description: "This permanently removes the channel and its messages.",
        confirmLabel: "Delete channel",
        destructive: true,
      })
    ) {
      await removeChannel({ id: ch.id });
      if (params.channelId === ch.id) void router.visit(`/o/${orbitId}`, { clientOnly: true });
    }
  }

  function categoryMenu(cat: Category): MenuItem[] {
    if (!canManage) return [];
    return [
      { type: "label", label: cat.name },
      { label: "New channel", icon: <Plus />, onSelect: () => setCreateIn(cat.id) },
      { label: "Edit category", icon: <Pencil />, onSelect: () => setEditCategory(cat) },
      { type: "separator" },
      {
        label: "Delete category",
        icon: <Trash2 />,
        destructive: true,
        onSelect: () => void deleteCategory(cat),
      },
    ];
  }
  async function deleteCategory(cat: Category) {
    if (
      await confirm({
        title: `Delete ${cat.name}?`,
        description: "Channels inside it move to no category — they aren't deleted.",
        confirmLabel: "Delete category",
        destructive: true,
      })
    ) {
      await removeCategory({ orbitId, categoryId: cat.id });
    }
  }

  return (
    <aside
      className={cn(
        "atmos-rail flex shrink-0 flex-col border-r border-border-strong bg-rail transition-transform duration-300 ease-out",
        // Mobile: a full-screen drawer that slides in behind the chat (z-10),
        // pinned below the safe area and padded left for the fixed orbit rail it
        // moves in lockstep with (same 85vw distance). The OrbitView notch-filler
        // paints --rail above it under the status bar.
        "fixed left-0 top-[var(--sat)] z-10 h-[calc(var(--app-h)_-_var(--sat))] w-[85vw] pl-[68px]",
        leftOpen ? "translate-x-0" : "-translate-x-full",
        // Desktop: in-flow 244px column (relative keeps the orbit-menu anchored).
        "md:relative md:left-auto md:top-auto md:z-auto md:h-auto md:w-[244px] md:translate-x-0 md:pl-0",
      )}
    >
      {/* Orbit header — the title + chevron stay pinned at the top; a cover
          (when set) makes the bar taller and shows behind, with a top scrim so
          the title stays legible. The orbit icon lives in the rail, not here. */}
      <button
        ref={orbitMenuTriggerRef}
        onClick={() => setMenuOpen((v) => !v)}
        className={cn(
          // overflow-hidden clips the cover image; the header is edge-to-edge on
          // mobile and framed by <main>'s rounded corner on desktop, so no radius here.
          "relative w-full shrink-0 overflow-hidden border-b border-border-strong text-left transition-colors hover:bg-accent/30",
          orbit?.cover ? "h-[104px]" : "h-12",
        )}
      >
        {orbit?.cover && (
          <>
            <img src={orbit.cover} alt="" referrerPolicy="no-referrer" className="absolute inset-0 size-full object-cover" />
            <span className="absolute inset-0 bg-gradient-to-b from-rail via-rail/70 to-transparent" />
          </>
        )}
        {/* Title + chevron pinned to the top edge, identical with or without a cover. */}
        <div className="absolute inset-x-0 top-0 z-10 flex h-12 items-center gap-2 px-3.5">
          <span className="truncate text-[14.5px] font-semibold tracking-tight drop-shadow-sm">{orbit?.name}</span>
          <ChevronDown className={cn("ml-auto size-4 shrink-0 text-muted-foreground transition-transform", menuOpen && "rotate-180")} />
        </div>
      </button>
      <OrbitMenu
        open={menuOpen}
        top={52}
        triggerRef={orbitMenuTriggerRef}
        canInvite={canInvite}
        canManage={canManage}
        canSettings={canSettings}
        isOwner={!!orbit?.isOwner}
        onClose={() => setMenuOpen(false)}
        onInvite={() => setInviteOpen(true)}
        onNewChannel={() => setCreateIn(null)}
        onNewCategory={() => setCreateCat(true)}
        onSettings={() => void router.visit(`/o/${orbitId}/settings`, { clientOnly: true })}
        onLeave={onLeave}
        onDelete={onDelete}
      />

      <ScrollArea className="flex-1">
        <MorphIndicatorGroup
          activeId={params.channelId}
          className="flex flex-col gap-0.5 px-2 pt-2 pb-[max(0.5rem,var(--sab))]"
        >
          {channels === undefined &&
            Array.from({ length: 8 }).map((_, i) => (
              <div key={`sk-${i}`} className="flex items-center gap-2 px-2 py-1.5">
                <Skeleton className="size-4 shrink-0 rounded" />
                <Skeleton className="h-3.5" style={{ width: [110, 78, 96, 64, 120, 84, 100, 72][i % 8] }} />
              </div>
            ))}
          {/* Uncategorized channels (the group container catches end-of-list drops). */}
          <div
            className="flex flex-col gap-0.5"
            onDragOver={(e) => groupOver(e, null, view.uncategorized.length)}
            onDrop={(e) => groupDrop(e, null, view.uncategorized.length)}
          >
            {view.uncategorized.map((ch, i) => renderChannel(ch, null, i))}
            {chanLineAt(null, view.uncategorized.length) && <DropLine />}
            {drag?.kind === "channel" && view.uncategorized.length === 0 && <div className="h-5" />}
          </div>

          {view.cats.map(({ cat, channels: chans }, ci) => {
            const isCollapsed = collapsed.has(cat.id);
            const dragging = drag?.kind === "category" && drag.id === cat.id;
            const channelDropHere =
              drag?.kind === "channel" && over?.kind === "channel" && over.catId === cat.id && over.index === 0;
            return (
              <Fragment key={cat.id}>
                {catLineAt(ci) && <DropLine wide />}
                {/* The block is the category DROP target, but NOT a drag source:
                    only the header drags. If the whole block were draggable it
                    would nest the channels' drag sources inside it, which made
                    channel drags fire intermittently (the category drag kept
                    winning). Header-only source = no nesting = reliable. */}
                <div
                  className={cn("mt-2", dragging && "opacity-40")}
                  onDragOver={(e) => catAreaOver(e, ci)}
                  onDrop={(e) => catAreaDrop(e, ci)}
                >
                  <div
                    className={cn(
                      "group flex select-none items-center gap-1 rounded-md px-1.5 transition-colors",
                      canManage && "cursor-grab active:cursor-grabbing",
                      channelDropHere && "bg-primary/10",
                    )}
                    draggable={canManage}
                    onDragStart={(e) => startCategoryDrag(e, cat.id)}
                    onDragEnd={resetDrag}
                    onContextMenu={(e) => openMenu(e, categoryMenu(cat))}
                    onDragOver={(e) => headerOver(e, cat.id)}
                    onDrop={(e) => headerDrop(e, cat.id)}
                  >
                    <button
                      onClick={() =>
                        setCollapsed((s) => {
                          const n = new Set(s);
                          n.has(cat.id) ? n.delete(cat.id) : n.add(cat.id);
                          return n;
                        })
                      }
                      className="flex flex-1 items-center gap-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                    >
                      {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                      {cat.name}
                    </button>
                    {canManage && (
                      <button
                        onClick={() => setCreateIn(cat.id)}
                        aria-label={`New channel in ${cat.name}`}
                        className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      >
                        <Plus className="size-3.5 text-muted-foreground" />
                      </button>
                    )}
                  </div>
                  {!isCollapsed && (
                    <div
                      className="flex flex-col gap-px"
                      onDragOver={(e) => groupOver(e, cat.id, chans.length)}
                      onDrop={(e) => groupDrop(e, cat.id, chans.length)}
                    >
                      {chans.map((ch, j) => renderChannel(ch, cat.id, j))}
                      {chanLineAt(cat.id, chans.length) && <DropLine />}
                      {drag?.kind === "channel" && chans.length === 0 && <div className="h-5" />}
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
          {catLineAt(view.cats.length) && <DropLine wide />}
        </MorphIndicatorGroup>
      </ScrollArea>

      {createIn !== undefined && (
        <CreateChannelModal orbitId={orbitId} categoryId={createIn} categories={categories ?? []} onClose={() => setCreateIn(undefined)} />
      )}
      {createCat && <CreateCategoryModal orbitId={orbitId} onClose={() => setCreateCat(false)} />}
      {editChannel && (
        <EditChannelModal channel={editChannel} categories={categories ?? []} onClose={() => setEditChannel(null)} />
      )}
      {editCategory && <EditCategoryModal category={editCategory} onClose={() => setEditCategory(null)} />}
      {inviteOpen && orbit && (
        <InvitePeopleModal orbitId={orbitId} orbitName={orbit.name} onClose={() => setInviteOpen(false)} />
      )}
      {confirmDialog}
    </aside>
  );
}

/** A 2px insertion bar drawn in-flow but with zero height (no layout shift). */
function DropLine({ wide }: { wide?: boolean }) {
  return (
    <div className="relative h-0">
      <div
        className={cn(
          "pointer-events-none absolute z-[3] h-0.5 rounded-full bg-primary",
          wide ? "inset-x-1.5 -top-1" : "inset-x-2 -top-px",
        )}
      />
    </div>
  );
}

function ChannelRow({
  orbitId,
  channel,
  active,
  unread,
  onContext,
  draggable,
  dimmed,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  orbitId: string;
  channel: Channel;
  active: boolean;
  unread: boolean;
  onContext: (e: React.MouseEvent) => void;
  draggable?: boolean;
  dimmed?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  const { closeLeft } = useMobileNav();
  return (
    <Link
      href={`/o/${orbitId}/c/${channel.id}`}
      clientOnly
      prefetch="render"
      onClick={closeLeft}
      onContextMenu={onContext}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "group relative z-[1] flex select-none items-center gap-1.5 rounded-lg px-2 py-[6px] text-[13.5px] transition-colors",
        active
          ? "bg-accent font-medium text-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/0.06)]"
          : unread
            ? "font-medium text-foreground hover:bg-accent/50"
            : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
        dimmed && "opacity-40",
      )}
    >
      <Hash className={cn("size-4 shrink-0", active ? "opacity-80" : "opacity-45")} />
      <span className="truncate">{channel.name}</span>
      {!active && unread && <span className="unread-dot ml-auto size-2 shrink-0 rounded-full" />}
    </Link>
  );
}

function OrbitMenu({
  open,
  top,
  triggerRef,
  canInvite,
  canManage,
  canSettings,
  isOwner,
  onClose,
  onInvite,
  onNewChannel,
  onNewCategory,
  onSettings,
  onLeave,
  onDelete,
}: {
  open: boolean;
  top: number;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  canInvite: boolean;
  canManage: boolean;
  canSettings: boolean;
  isOwner: boolean;
  onClose: () => void;
  onInvite: () => void;
  onNewChannel: () => void;
  onNewCategory: () => void;
  onSettings: () => void;
  onLeave: () => void;
  onDelete: () => void;
}) {
  const { render, state } = useAnimatedOpen(open, 130);
  const menuRef = useRef<HTMLDivElement>(null);
  // Close on any outside interaction. (A `fixed inset-0` overlay can't be used
  // here: the sidebar <aside> has a transform for its mobile-drawer slide, which
  // makes `fixed` resolve to the aside instead of the viewport — so the overlay
  // wouldn't cover the orbit rail or chat, and clicking another orbit never
  // closed the menu.) A passive mousedown listener closes without swallowing the
  // click, so switching orbits both navigates and dismisses.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, triggerRef]);
  const item = "flex w-full items-center gap-2.5 px-2.5 py-[7px] text-[13px] text-left";
  const destructive = "rounded-[9px] text-destructive transition-colors hover:bg-destructive/15";
  if (!render) return null;
  return (
    <>
      <div
        ref={menuRef}
        data-anim="dropdown"
        data-state={state}
        className={cn(
          // Anchored to the <aside> (its containing block). On mobile the aside
          // pads 68px for the fixed orbit rail, but padding doesn't inset an
          // absolute child — so clear the rail explicitly here.
          "menu-surface absolute left-[calc(68px_+_0.5rem)] right-2 z-30 p-1.5 md:left-2",
          state === "closed" && "pointer-events-none",
        )}
        style={{ top, transformOrigin: "top center" }}
      >
        {canInvite && (
          <>
            <button className={cn(item, "rounded-[9px] text-primary transition-colors hover:bg-primary/12")} onClick={() => { onClose(); onInvite(); }}>
              <UserPlus className="size-4" />
              <span className="flex-1">Invite people</span>
            </button>
            {(canManage || canSettings) && <div className="menu-sep" />}
          </>
        )}
        {canManage && (
          <>
            <button className={cn(item, "menu-item text-foreground")} onClick={() => { onClose(); onNewChannel(); }}>
              <Plus className="size-4 text-muted-foreground" />
              New channel
            </button>
            <button className={cn(item, "menu-item text-foreground")} onClick={() => { onClose(); onNewCategory(); }}>
              <FolderPlus className="size-4 text-muted-foreground" />
              New category
            </button>
          </>
        )}
        {canSettings && (
          <button className={cn(item, "menu-item text-foreground")} onClick={() => { onClose(); onSettings(); }}>
            <Settings className="size-4 text-muted-foreground" />
            Orbit settings
          </button>
        )}
        {(canInvite || canManage || canSettings) && <div className="menu-sep" />}
        {isOwner ? (
          <button className={cn(item, destructive)} onClick={() => { onClose(); onDelete(); }}>
            <Trash2 className="size-4" />
            Delete orbit
          </button>
        ) : (
          <button className={cn(item, destructive)} onClick={() => { onClose(); onLeave(); }}>
            <LogOut className="size-4" />
            Leave orbit
          </button>
        )}
      </div>
    </>
  );
}

function CreateChannelModal({
  orbitId,
  categoryId,
  categories,
  onClose,
}: {
  orbitId: string;
  categoryId: string | null;
  categories: Category[];
  onClose: () => void;
}) {
  const create = useMutation(api.channels.create);
  const router = useRouter();
  const [name, setName] = useState("");
  const [cat, setCat] = useState<string>(categoryId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await create({ orbitId, name, categoryId: cat || undefined });
      onClose();
      void router.visit(`/o/${orbitId}/c/${res.id}`, { clientOnly: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <h2 className="mb-4 text-[15px] font-semibold tracking-tight">Create channel</h2>
      <form onSubmit={submit}>
        <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">Name</label>
        <div className="relative">
          <Hash className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="new-channel" className="h-10 bg-raised pl-8" />
        </div>
        {categories.length > 0 && (
          <>
            <label className="mb-1.5 mt-3 block text-[12px] font-medium text-muted-foreground">Category</label>
            <Select
              value={cat}
              onChange={setCat}
              ariaLabel="Category"
              options={[{ value: "", label: "No category" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
            />
          </>
        )}
        {error && <p className="mt-2 text-[12.5px] text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" className="h-9" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()} className="h-9 gap-2 bg-primary text-primary-foreground hover:bg-primary-hover">
            {busy && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CreateCategoryModal({ orbitId, onClose }: { orbitId: string; onClose: () => void }) {
  const create = useMutation(api.categories.create);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await create({ orbitId, name });
      onClose();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose}>
      <h2 className="mb-4 text-[15px] font-semibold tracking-tight">Create category</h2>
      <form onSubmit={submit}>
        <Input ref={ref} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Resources" className="h-10 bg-raised" />
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" className="h-9" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()} className="h-9 gap-2 bg-primary text-primary-foreground hover:bg-primary-hover">
            {busy && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EditCategoryModal({ category, onClose }: { category: Category; onClose: () => void }) {
  const update = useMutation(api.categories.update);
  const [name, setName] = useState(category.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await update({ categoryId: category.id, name });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose}>
      <h2 className="mb-4 text-[15px] font-semibold tracking-tight">Edit category</h2>
      <form onSubmit={submit}>
        <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">Name</label>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Category name" className="h-10 bg-raised" />
        {error && <p className="mt-2 text-[12.5px] text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" className="h-9" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()} className="h-9 gap-2 bg-primary text-primary-foreground hover:bg-primary-hover">
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function parseRoles(value: string | null | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

function EditChannelModal({
  channel,
  categories,
  onClose,
}: {
  channel: Channel;
  categories: Category[];
  onClose: () => void;
}) {
  const update = useMutation(api.channels.update);
  const roles = useQuery(api.roles.list, { orbitId: channel.orbit_id });
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [cat, setCat] = useState<string>(channel.category_id ?? "");
  // null = not yet initialised (waiting on the roles query).
  const [viewRoles, setViewRoles] = useState<Set<string> | null>(null);
  const [sendRoles, setSendRoles] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inited = useRef(false);

  // Initialise from the saved overrides once roles load. Inclusive model: an
  // empty/unset override means "everyone", which we show as *all roles selected*
  // so you can remove some to restrict (or add them back to open it up again).
  useEffect(() => {
    if (inited.current || !roles) return;
    inited.current = true;
    const all = new Set(roles.map((r) => r.id));
    const v = parseRoles(channel.view_roles);
    const s = parseRoles(channel.send_roles);
    setViewRoles(v.size ? v : all);
    setSendRoles(s.size ? s : new Set(all));
  }, [roles, channel.view_roles, channel.send_roles]);

  // All-selected → store "everyone" (empty → null server-side, future-proof as
  // roles change). A strict subset → store exactly those roles.
  function toArg(set: Set<string> | null): string[] {
    if (!set || !roles) return [];
    const isAll = set.size >= roles.length && roles.every((r) => set.has(r.id));
    return isAll ? [] : [...set];
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await update({
        id: channel.id,
        name,
        topic,
        categoryId: cat,
        viewRoles: toArg(viewRoles),
        sendRoles: toArg(sendRoles),
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} className="max-w-[460px]">
      <h2 className="mb-4 text-[15px] font-semibold tracking-tight">Edit channel</h2>
      <form onSubmit={submit}>
        <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">Name</label>
        <div className="relative">
          <Hash className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="channel-name" className="h-10 bg-raised pl-8" />
        </div>

        <label className="mb-1.5 mt-3 block text-[12px] font-medium text-muted-foreground">Topic</label>
        <Input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="What's this channel about?"
          maxLength={120}
          className="h-10 bg-raised"
        />

        {categories.length > 0 && (
          <>
            <label className="mb-1.5 mt-3 block text-[12px] font-medium text-muted-foreground">Category</label>
            <Select
              value={cat}
              onChange={setCat}
              ariaLabel="Category"
              options={[{ value: "", label: "No category" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
            />
          </>
        )}

        <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted-foreground">Who can view</label>
        <RoleTagInput roles={roles ?? []} value={viewRoles ?? new Set()} onChange={setViewRoles} placeholder="Hidden from everyone but the owner" />

        <label className="mb-1.5 mt-3 block text-[12px] font-medium text-muted-foreground">Who can send</label>
        <RoleTagInput roles={roles ?? []} value={sendRoles ?? new Set()} onChange={setSendRoles} placeholder="Only the owner can send" />

        {error && <p className="mt-2 text-[12.5px] text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" className="h-9" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()} className="h-9 gap-2 bg-primary text-primary-foreground hover:bg-primary-hover">
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A tag/chip multi-select for roles: selected roles show as removable chips,
 *  and a dropdown adds the rest. The owner always has access regardless. */
function RoleTagInput({
  roles,
  value,
  onChange,
  placeholder,
}: {
  roles: EditRole[];
  value: Set<string>;
  onChange: (s: Set<string>) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = roles.filter((r) => value.has(r.id));
  const available = roles.filter((r) => !value.has(r.id));
  const add = (id: string) => {
    const n = new Set(value);
    n.add(id);
    onChange(n);
    setOpen(false);
  };
  const remove = (id: string) => {
    const n = new Set(value);
    n.delete(id);
    onChange(n);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-input bg-raised p-2">
      {selected.length === 0 && (
        <span className="px-1 text-[12.5px] text-muted-foreground">{placeholder}</span>
      )}
      {selected.map((r) => {
        const tint = roleTint(r.color);
        return (
          <span
            key={r.id}
            className="inline-flex items-center gap-1.5 rounded-md bg-elevated py-1 pl-2 pr-1 text-[12.5px] font-medium"
            style={tint ? { color: tint } : undefined}
          >
            <span className="size-2 rounded-full" style={{ background: tint ?? "var(--muted-foreground)" }} />
            {r.name}
            <button
              type="button"
              aria-label={`Remove ${r.name}`}
              onClick={() => remove(r.id)}
              className="grid size-4 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}
      {available.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-strong px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:border-input hover:text-foreground"
          >
            <Plus className="size-3" />
            Add role
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div className="menu-surface animate-in-fast absolute left-0 top-full z-50 mt-1 max-h-[200px] min-w-[170px] overflow-auto p-1">
                {available.map((r) => {
                  const tint = roleTint(r.color);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => add(r.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
                    >
                      <span className="size-2 shrink-0 rounded-full" style={{ background: tint ?? "var(--muted-foreground)" }} />
                      <span className="truncate" style={tint ? { color: tint } : undefined}>{r.name}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
