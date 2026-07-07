import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "@rabbat/react";
import { usePaginatedQuery, useMutation, useQuery } from "@rabbat/react";
import { AtSign, Bell, CheckCheck, Reply } from "lucide-react";

import { api } from "@/rabbat";
import { cn } from "@/lib/utils";
import { useAnimatedOpen } from "@/components/ui/use-animated-open";
import { bodyPreview, initials, userColor } from "@/lib/util";

interface Notif {
  id: string;
  kind: string;
  orbit_id: string;
  channel_id: string;
  message_id: string;
  snippet: string;
  read: boolean | null;
  created_at: number;
  actor_name: string;
  actor_image: string | null;
  actor_accent: string | null;
  channel_name: string;
}

function relTime(ms: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : new Date(ms).toLocaleDateString();
}

/** The inbox bell + popover. Lives in the orbit rail above Settings. */
export function NotificationInbox() {
  const [open, setOpen] = useState(false);
  const unread = useQuery(api.notifications.unread, {}) as { count: number } | undefined;
  const count = unread?.count ?? 0;
  const { render, state } = useAnimatedOpen(open, 150);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Notifications"
        aria-pressed={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative grid size-9 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-elevated hover:text-foreground active:scale-90",
          open && "bg-elevated text-foreground",
        )}
      >
        <Bell className="size-[18px]" />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-primary px-1 text-[9.5px] font-bold leading-none text-primary-foreground ring-2 ring-rail">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>
      {render && <InboxPanel state={state} onClose={() => setOpen(false)} />}
    </div>
  );
}

function InboxPanel({ state, onClose }: { state: "open" | "closed"; onClose: () => void }) {
  const router = useRouter();
  const result = usePaginatedQuery(api.notifications.list, {}, { initialNumItems: 20 });
  const items = result.data as unknown as Notif[];
  const markRead = useMutation(api.notifications.markRead);
  const markAll = useMutation(api.notifications.markAllRead);

  function openNotif(n: Notif) {
    void markRead({ id: n.id }).catch(() => {});
    onClose();
    void router.visit(`/o/${n.orbit_id}/c/${n.channel_id}?at=${n.message_id}`, { clientOnly: true });
  }

  // Portal to <body> so the fixed overlay escapes the orbit rail's transform
  // (the mobile drawer slide makes the rail a containing block) + overflow clip.
  return createPortal(
    <>
      <div data-anim="overlay" data-state={state} className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        data-anim="menu"
        data-state={state}
        style={{ transformOrigin: "bottom left" }}
        className={cn(
          "menu-surface fixed bottom-4 left-[78px] z-50 flex max-h-[70dvh] w-[min(360px,calc(100vw-92px))] flex-col overflow-hidden",
          state === "closed" && "pointer-events-none",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-[14px] font-semibold tracking-tight">Inbox</h3>
          <button
            type="button"
            onClick={() => void markAll({}).catch(() => {})}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <CheckCheck className="size-3.5" />
            Mark all read
          </button>
        </div>
        <div
          className="flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (result.hasOlder && el.scrollHeight - el.scrollTop - el.clientHeight < 160) result.loadOlder();
          }}
        >
          {items.length === 0 ? (
            <div className="px-4 py-12 text-center text-[13px] text-muted-foreground">
              Nothing yet. Mentions and replies will show up here.
            </div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => openNotif(n)}
                className={cn(
                  "flex w-full items-start gap-3 border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-white/[0.04]",
                  n.read !== true && "bg-primary/[0.06]",
                )}
              >
                <span className="relative mt-0.5 grid size-8 shrink-0 place-items-center overflow-hidden rounded-full">
                  {n.actor_image ? (
                    <img src={n.actor_image} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <span
                      className="grid size-full place-items-center text-[11px] font-semibold text-white/95"
                      style={{ background: userColor(n.actor_accent, n.actor_name) }}
                    >
                      {initials(n.actor_name)}
                    </span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug text-foreground/90">
                    <span className="font-semibold text-foreground">{n.actor_name}</span>{" "}
                    {n.kind === "mention" ? "mentioned you" : "replied to you"} in{" "}
                    <span className="font-medium">#{n.channel_name}</span>
                  </p>
                  {n.snippet && <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{bodyPreview(n.snippet)}</p>}
                  <p className="mt-1 text-[11px] text-faint">{relTime(n.created_at)}</p>
                </div>
                {n.kind === "mention" ? (
                  <AtSign className="mt-0.5 size-3.5 shrink-0 text-primary" />
                ) : (
                  <Reply className="mt-0.5 size-3.5 shrink-0 text-primary" />
                )}
              </button>
            ))
          )}
          {result.hasOlder && (
            <div className="py-3 text-center text-[12px] text-muted-foreground">Loading more…</div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
