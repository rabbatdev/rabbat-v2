import { useEffect, useState } from "react";
import { Meta } from "@rabbat/react";
import { useMutation, useQuery } from "@rabbat/react";
import { Hash, Lock, Menu, Users } from "lucide-react";

import { api, type Channel } from "@/rabbat";
import { useMobileNav } from "@/context/mobile-nav";
import { useOrbit } from "@/context/orbit-context";
import { cn } from "@/lib/utils";
import { MessageList, type EditTarget, type ReplyTarget } from "./MessageList";
import { Composer } from "./Composer";

interface Props {
  orbitId: string;
  channelId: string;
  anchor: string | null;
}

export function ChatPanel({ orbitId, channelId, anchor }: Props) {
  const { openLeft, toggleRight, rightOpen } = useMobileNav();
  const channel = useQuery(api.channels.get, { id: channelId }) as
    | (Channel & { canSend?: boolean })
    | null
    | undefined;
  // Default to allowed while loading; the server is the source of truth.
  const canSend = channel?.canSend !== false;
  const orbit = useOrbit();
  // Tab title: "#general · BG Test" while we have the channel, else the orbit.
  const title = channel?.name
    ? `#${channel.name}${orbit?.name ? ` · ${orbit.name}` : ""}`
    : orbit?.name ?? undefined;
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const markRead = useMutation(api.readState.markRead);

  // Keep this channel marked read while it's open.
  useEffect(() => {
    const fire = () => {
      if (document.visibilityState === "visible") void markRead({ channelId }).catch(() => {});
    };
    fire();
    const iv = setInterval(fire, 8_000);
    document.addEventListener("visibilitychange", fire);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", fire);
    };
  }, [channelId, markRead]);

  return (
    <section className="atmos-chat flex h-full min-h-0 flex-1 flex-col bg-background">
      <Meta title={title} />
      <header className="glass-header z-10 flex h-12 shrink-0 items-center gap-1.5 border-b border-border-strong px-2.5 md:gap-2.5 md:px-4">
        <button
          onClick={openLeft}
          aria-label="Open channels"
          className="-ml-0.5 grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground active:scale-90 md:hidden"
        >
          <Menu className="size-5" />
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-secondary/80">
            <Hash className="size-3.5 text-muted-foreground" />
          </span>
          <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">{channel?.name ?? "…"}</h1>
        </div>
        {channel?.topic && (
          <>
            <span className="mx-2 hidden h-4 w-px shrink-0 bg-border-strong lg:block" />
            <p className="hidden truncate text-[13px] text-muted-foreground lg:block">{channel.topic}</p>
          </>
        )}
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

      <MessageList
        orbitId={orbitId}
        channelId={channelId}
        channelName={channel?.name}
        anchor={anchor}
        onReply={(m) => {
          setEditing(null);
          setReplyingTo(m);
        }}
        onEdit={(m) => {
          setReplyingTo(null);
          setEditing(m);
        }}
      />
      {canSend ? (
        <Composer
          channelId={channelId}
          channelName={channel?.name}
          replyingTo={replyingTo}
          onClearReply={() => setReplyingTo(null)}
          editing={editing}
          onClearEdit={() => setEditing(null)}
        />
      ) : (
        <div className="shrink-0 px-4 pb-4 pt-1">
          <div className="flex items-center justify-center gap-2 rounded-xl border border-border-strong bg-raised px-4 py-3 text-[13px] text-muted-foreground">
            <Lock className="size-4 shrink-0" />
            Only certain roles can send messages in {channel?.name ? `#${channel.name}` : "this channel"}.
          </div>
        </div>
      )}
    </section>
  );
}
