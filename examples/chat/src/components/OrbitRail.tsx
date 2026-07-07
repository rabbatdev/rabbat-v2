import { useState } from "react";
import { Link, useRouter, useParams } from "@rabbat/react";
import { useMutation, useQuery } from "@rabbat/react";
import { LogOut, Plus, Settings } from "lucide-react";

import { api, type Orbit } from "@/rabbat";
import { useIdentity } from "@/context/identity";
import { useMobileNav } from "@/context/mobile-nav";
import { CreateOrbitModal } from "./Onboarding";
import { UserMenu, StatusDot } from "./UserMenu";
import { NotificationInbox } from "./NotificationInbox";
import { useConfirm } from "./ConfirmDialog";
import { useContextMenu, type MenuItem } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { MorphIndicatorGroup, MorphIndicatorItem } from "@/components/ui/morph-indicator";
import { cn } from "@/lib/utils";
import { initials, statusMeta } from "@/lib/util";

function orbitColor(hue: number): string {
  return `linear-gradient(140deg, oklch(0.62 0.11 ${hue}), oklch(0.5 0.12 ${(hue + 30) % 360}))`;
}

export function OrbitRail() {
  const orbits = useQuery(api.orbits.listMine, {});
  const profile = useQuery(api.profile.me, {});
  const params = useParams<{ orbitId?: string }>();
  const me = useIdentity();
  const { leftOpen } = useMobileNav();
  const router = useRouter();
  const openMenu = useContextMenu();
  const { confirm, confirmDialog } = useConfirm();
  const myPresence = useQuery(api.presence.me, {}) as { status: string } | undefined;
  const leave = useMutation(api.orbits.leave);
  const [creating, setCreating] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const openSettings = () => router.visit("/settings", { clientOnly: true });

  const avatar = profile?.image ?? me.image;
  const myStatus = myPresence?.status ?? "online";

  async function onLeave(o: Orbit) {
    if (
      await confirm({
        title: `Leave ${o.name}?`,
        description: "You'll need an invite to rejoin.",
        confirmLabel: "Leave",
        destructive: true,
      })
    ) {
      await leave({ orbitId: o.id });
      if (params.orbitId === o.id) router.visit("/", { clientOnly: true });
    }
  }

  function menuFor(o: Orbit): MenuItem[] {
    const isOwner = o.owner_id === me.userId;
    const items: MenuItem[] = [];
    if (!isOwner) {
      items.push({ label: "Leave orbit", icon: <LogOut />, destructive: true, onSelect: () => void onLeave(o) });
    }
    return items;
  }

  return (
    <aside
      className={cn(
        // Fixed drawer on mobile spans the full height, so pad past the notch /
        // home indicator (the root's safe-area padding can't reach a fixed child).
        // Mobile: a full-height border-r is the inset divider that separates the
        // rail from the channel list (it rides the channel pane's left edge and
        // runs continuously up through the notch). Desktop: frame, no divider.
        "flex w-[68px] shrink-0 flex-col overflow-hidden border-r border-border-strong bg-[var(--rail)] pt-[max(0.75rem,var(--sat))] pb-[max(0.75rem,var(--sab))] md:border-r-0 md:bg-[var(--frame)]",
        // Mobile: the orbit rail rides the left edge of the channel pane in the
        // OrbitView pager — same slide distance (85vw) + duration so the two move
        // in lockstep when the left "screen" opens. Full height (100svh) so it
        // reaches the bottom of the PWA.
        "fixed left-0 top-0 z-40 h-[var(--app-h)] transition-transform duration-300 ease-out",
        leftOpen ? "translate-x-0" : "-translate-x-[85vw]",
        // Desktop: in flow, no drawer transform.
        "md:relative md:left-auto md:top-auto md:z-auto md:h-auto md:translate-x-0",
      )}
    >
      <MorphIndicatorGroup
        activeId={params.orbitId}
        className="flex min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto"
      >
        {orbits === undefined &&
          Array.from({ length: 4 }).map((_, i) => (
            <div key={`sk-${i}`} className="flex w-full justify-center">
              <Skeleton className="size-11 rounded-[22px]" />
            </div>
          ))}
        {(orbits ?? []).map((o) => {
          const active = o.id === params.orbitId;
          return (
            <MorphIndicatorItem key={o.id} id={o.id} className="flex w-full justify-center">
              <RailButton label={o.name}>
                <Link
                  href={`/o/${o.id}`}
                  clientOnly
                  prefetch="render"
                  aria-label={o.name}
                  onContextMenu={(e) => openMenu(e, menuFor(o))}
                  className={cn(
                    "relative z-[1] grid size-11 place-items-center overflow-hidden text-[14px] font-semibold text-white transition-[border-radius,transform] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] active:scale-90",
                    active ? "rounded-2xl" : "rounded-[22px] hover:rounded-2xl",
                  )}
                  style={o.icon ? undefined : { background: orbitColor(o.hue) }}
                >
                  {o.icon ? (
                    <img src={o.icon} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    initials(o.name)
                  )}
                </Link>
              </RailButton>
            </MorphIndicatorItem>
          );
        })}

        <RailButton label="Add an orbit">
          <button
            type="button"
            aria-label="Add an orbit"
            onClick={() => setCreating(true)}
            className="relative z-[1] grid size-11 place-items-center rounded-[22px] bg-elevated text-primary transition-[border-radius,background-color,transform] duration-150 hover:rounded-2xl hover:bg-primary hover:text-primary-foreground active:scale-90"
          >
            <Plus className="size-5" />
          </button>
        </RailButton>
      </MorphIndicatorGroup>

      <div className="mt-1 flex shrink-0 flex-col items-center gap-2">
        <div className="h-px w-7 bg-border-strong" />

        <RailButton label="Notifications">
          <NotificationInbox />
        </RailButton>

        <RailButton label="Settings">
          <button
            type="button"
            aria-label="Settings"
            onClick={openSettings}
            className="press grid size-9 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-elevated hover:text-foreground"
          >
            <Settings className="size-[18px]" />
          </button>
        </RailButton>

        <RailButton label={`${me.displayName} — ${statusMeta(myStatus).label}`}>
          <button
            type="button"
            aria-label="Your profile and status"
            onClick={() => setUserMenuOpen((v) => !v)}
            className="relative grid size-11 place-items-center rounded-full ring-1 ring-border-strong transition-transform active:scale-90"
          >
            <span className="grid size-full place-items-center overflow-hidden rounded-full">
              {avatar ? (
                <img src={avatar} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="brand-mark grid size-full place-items-center text-[13px] font-semibold text-white">
                  {initials(me.displayName)}
                </span>
              )}
            </span>
            <StatusDot
              status={myStatus}
              size={13}
              surface="var(--rail)"
              className="absolute -bottom-0.5 -right-0.5"
            />
          </button>
        </RailButton>
      </div>

      <UserMenu open={userMenuOpen} onClose={() => setUserMenuOpen(false)} status={myStatus} />
      <CreateOrbitModal open={creating} onClose={() => setCreating(false)} />
      {confirmDialog}
    </aside>
  );
}

function RailButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex w-full min-w-0 justify-center">{children}</div>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
