import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "@rabbat/react";
import { Check, LogOut } from "lucide-react";

import { api } from "@/rabbat";
import { useIdentity } from "@/context/identity";
import { cn } from "@/lib/utils";
import { useAnimatedOpen } from "@/components/ui/use-animated-open";
import { initials, statusMeta } from "@/lib/util";

const STATUS_OPTIONS: { key: string; label: string }[] = [
  { key: "online", label: "Online" },
  { key: "busy", label: "Busy" },
  { key: "invisible", label: "Invisible" },
];

/** A presence badge. It sits over the corner of an avatar, so it draws a moat
 *  ring in the surrounding `surface` colour to separate it cleanly, and — for
 *  the hollow (offline/invisible) states — fills its centre with that same
 *  surface colour so the avatar never shows through the badge. */
export function StatusDot({
  status,
  size = 11,
  surface = "var(--rail)",
  className,
}: {
  status: string;
  size?: number;
  surface?: string;
  className?: string;
}) {
  const { color, hollow } = statusMeta(status);
  const moat = Math.max(2, Math.round(size / 4.5));
  const stroke = Math.max(2, Math.round(size / 3.2));
  return (
    <span
      className={cn("block rounded-full", className)}
      style={{
        width: size,
        height: size,
        background: hollow ? surface : color,
        boxShadow: hollow
          ? `0 0 0 ${moat}px ${surface}, inset 0 0 0 ${stroke}px ${color}`
          : `0 0 0 ${moat}px ${surface}`,
      }}
    />
  );
}

export function UserMenu({
  open,
  onClose,
  status,
}: {
  open: boolean;
  onClose: () => void;
  status: string;
}) {
  const me = useIdentity();
  const profile = useQuery(api.profile.me, {});
  const setStatus = useMutation(api.presence.setStatus);
  const { render, state } = useAnimatedOpen(open, 150);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!render) return null;
  const image = profile?.image ?? me.image;
  const current = statusMeta(status);

  // Portal to <body> so the fixed overlay isn't trapped by the orbit rail's
  // transform (the mobile drawer slide makes the rail a containing block).
  return createPortal(
    <>
      <div data-anim="overlay" data-state={state} className="fixed inset-0 z-40" onClick={onClose} />
      <div
        data-anim="menu"
        data-state={state}
        style={{ transformOrigin: "bottom left" }}
        className="menu-surface fixed bottom-3 left-[74px] z-50 w-[238px] p-1.5"
      >
        {/* Identity header */}
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="relative grid size-9 shrink-0 place-items-center">
            <span className="grid size-full place-items-center overflow-hidden rounded-full ring-1 ring-border-strong">
              {image ? (
                <img src={image} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="brand-mark grid size-full place-items-center text-[12px] font-semibold text-white">
                  {initials(me.displayName)}
                </span>
              )}
            </span>
            <StatusDot status={status} surface="var(--menu-bg)" className="absolute -bottom-0.5 -right-0.5" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold leading-tight tracking-tight">{me.displayName}</div>
            <div className="truncate text-[11.5px] leading-tight" style={{ color: current.color }}>
              {current.label}
            </div>
          </div>
        </div>

        <div className="menu-sep" />

        {/* Status picker — one compact row each, like the other menus. */}
        {STATUS_OPTIONS.map((o) => {
          const active = o.key === status;
          return (
            <button
              key={o.key}
              onClick={() => {
                if (!active) void setStatus({ status: o.key });
                onClose();
              }}
              className="menu-item flex w-full items-center gap-2.5 px-2.5 py-[7px] text-left text-[13px]"
            >
              <StatusDot status={o.key} size={9} surface="var(--menu-bg)" />
              <span className="min-w-0 flex-1 truncate text-foreground">{o.label}</span>
              {active && <Check className="size-4 shrink-0 text-primary" />}
            </button>
          );
        })}

        <div className="menu-sep" />

        <button
          onClick={me.signOut}
          className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-[7px] text-left text-[13px] text-destructive transition-colors hover:bg-destructive/15"
        >
          <LogOut className="size-4" />
          Sign out
        </button>
      </div>
    </>,
    document.body,
  );
}
