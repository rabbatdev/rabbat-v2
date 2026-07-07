import type { ReactNode } from "react";
import { Meta } from "@rabbat/react";
import { useQuery, useKeepAlive } from "@rabbat/react";
import { Loader2, Menu, MessagesSquare, Users } from "lucide-react";

import { api } from "@/rabbat";
import { OrbitContext } from "@/context/orbit-context";
import { useMobileNav } from "@/context/mobile-nav";
import { cn } from "@/lib/utils";
import { ChannelSidebar } from "./ChannelSidebar";
import { MembersRail } from "./MembersRail";
import { MemberCardProvider } from "@/context/member-card";

// Matches MessageList's PAGE — the latest-tail window. (The window isn't part of
// the subscription key, so this just primes the same sub MessageList will adopt.)
const LATEST_TAIL = { before: 40, after: 0, anchor: { kind: "latest" as const } };

/** Keep every channel's latest message tail live while this orbit is open, so
 *  switching channels shows fresh messages instantly — no stale-then-revalidate
 *  flash. Scoped to the current orbit, so the tails are released when you leave. */
function KeepChannelTails({ orbitId }: { orbitId: string }) {
  const channels = useQuery(api.channels.list, { orbitId }) ?? [];
  useKeepAlive(
    channels.map((c) => ({ query: api.messages.list, args: { channelId: c.id }, pagination: LATEST_TAIL })),
  );
  return null;
}

export function OrbitView({ orbitId, children }: { orbitId: string; children?: ReactNode }) {
  const orbit = useQuery(api.orbits.get, { id: orbitId });
  const { leftOpen, rightOpen, closeAll } = useMobileNav();
  // Is a channel child currently rendered into this pane? (Orbit settings is a
  // standalone page that renders outside OrbitView entirely.)
  const hasContent = children != null;

  if (orbit === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (orbit === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-background text-center">
        <h1 className="text-lg font-semibold">Orbit unavailable</h1>
        <p className="max-w-xs text-sm text-muted-foreground">
          This orbit doesn't exist or you're not a member of it.
        </p>
      </div>
    );
  }

  return (
    <OrbitContext.Provider value={orbit}>
      <KeepChannelTails orbitId={orbitId} />
      <MemberCardProvider orbitId={orbitId}>
      <div className="relative flex min-w-0 flex-1 overflow-hidden md:overflow-visible">
        {/* Mobile: full-screen sidebars that slide in behind the chat. The chat is
            a normal layer that carries NO transform while you're typing (drawers
            closed) — iOS Safari breaks the contenteditable caret/selection under a
            transformed ancestor — and only translates aside *while* a sidebar
            opens (open channels → slide right, open members → slide left), leaving
            a peek to tap back. Desktop: it's the in-flow channels · chat · members
            row (the sidebars switch to static columns; the chat never translates). */}
        <ChannelSidebar orbitId={orbitId} />
        <div
          className={cn(
            "relative z-20 flex min-w-0 flex-1 flex-col bg-background transition-transform duration-300 ease-out md:z-auto md:translate-x-0",
            leftOpen ? "translate-x-[85vw]" : rightOpen ? "-translate-x-[85vw]" : "",
          )}
        >
          {hasContent ? children : <ChannelEmpty name={orbit.name} />}
          {/* Dim + tap the peeking chat to dismiss an open drawer (mobile only). */}
          <div
            onClick={closeAll}
            aria-hidden
            className={cn(
              "absolute inset-0 z-20 bg-black/40 transition-opacity duration-300 ease-out md:hidden",
              leftOpen || rightOpen ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />
        </div>
        <MembersRail orbitId={orbitId} />

        {/* Fill the safe-area notch above the full-screen sidebars so their --rail
            surface reads continuously up under the status bar — the panes sit
            below the root's safe-area padding, so they can't paint into the notch
            themselves. Each carries the pane's outer divider (border) up to the
            top; the channels filler starts past the orbit rail (whose own border-r
            divides it) and the chat's notch already matches its --background. */}
        <div
          aria-hidden
          className={cn(
            "fixed left-[68px] top-0 z-40 h-[var(--sat)] w-[calc(85vw_-_68px)] border-r border-border-strong bg-rail transition-opacity duration-300 ease-out md:hidden",
            leftOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
        <div
          aria-hidden
          className={cn(
            "fixed right-0 top-0 z-40 h-[var(--sat)] w-[85vw] border-l border-border-strong bg-rail transition-opacity duration-300 ease-out md:hidden",
            rightOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
      </div>
      </MemberCardProvider>
    </OrbitContext.Provider>
  );
}

function ChannelEmpty({ name }: { name: string }) {
  const { openLeft, toggleRight, rightOpen } = useMobileNav();
  return (
    <div className="atmos-chat flex flex-1 flex-col">
      <Meta title={name} />
      <header className="glass-header flex h-12 shrink-0 items-center gap-2 border-b border-border-strong px-3 md:px-4">
        <button
          onClick={openLeft}
          aria-label="Open channels"
          className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground active:scale-90 md:hidden"
        >
          <Menu className="size-5" />
        </button>
        <span className="truncate text-[15px] font-semibold tracking-tight">{name}</span>
        <button
          onClick={toggleRight}
          aria-label="Toggle members"
          aria-pressed={rightOpen}
          className={cn(
            "ml-auto grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground active:scale-90",
            rightOpen && "bg-accent text-foreground",
          )}
        >
          <Users className="size-[18px]" />
        </button>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <div className="brand-mark mb-6 grid size-16 place-items-center rounded-[20px] shadow-lg">
          <MessagesSquare className="size-7 text-white" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Welcome to {name}</h1>
        <p className="mt-2.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Pick a channel from the sidebar to start chatting with your orbit.
        </p>
      </div>
    </div>
  );
}
