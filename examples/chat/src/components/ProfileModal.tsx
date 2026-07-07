import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "@rabbat/react";
import {
  Bell,
  Camera,
  Check,
  Loader2,
  MonitorSmartphone,
  Smartphone,
  User,
} from "lucide-react";

import { api } from "@/rabbat";
import { useIdentity } from "@/context/identity";
import { authClient } from "@/lib/auth-client";
import { currentSubscription, permissionState, pushSupported, subscribePush, unsubscribePush } from "@/lib/push";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ImageUpload } from "./ImageUpload";
import { cn } from "@/lib/utils";
import { errorMessage, accentColor, initials } from "@/lib/util";

export type UserSettingsSection = "profile" | "notifications" | "sessions";

export const USER_SETTINGS_NAV: { key: UserSettingsSection; label: string; icon: React.ReactNode }[] = [
  { key: "profile", label: "Profile", icon: <User /> },
  { key: "notifications", label: "Notifications", icon: <Bell /> },
  { key: "sessions", label: "Sessions", icon: <MonitorSmartphone /> },
];

function SectionHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
      {desc && <p className="mt-1 text-[13px] text-muted-foreground">{desc}</p>}
    </div>
  );
}

// Accent presets (hue values). The default tracks the brand violet.
const ACCENTS = ["300", "330", "0", "30", "150", "200", "250"];

export function ProfileSection() {
  const me = useIdentity();
  const profile = useQuery(api.profile.me, {});
  const update = useMutation(api.profile.update);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [accent, setAccent] = useState<string>("300");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.name ?? "");
      setUsername(profile.username ?? "");
      setBio(profile.bio ?? "");
      setAccent(profile.accent ?? "300");
    }
  }, [profile]);

  const image = profile?.image ?? me.image;
  const cover = profile?.cover ?? null;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await update({ displayName, username, bio, accent });
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e) || "Couldn't save your profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ImageUpload onUploaded={(url) => update({ cover: url })} aspect={3} maxOutput={1280} title="Crop cover photo">
        {({ uploading, open: pick }) => (
          <button
            type="button"
            onClick={pick}
            className="group/cover relative block h-28 w-full overflow-hidden"
            style={cover ? undefined : { background: accentColor(accent) }}
            aria-label="Change cover photo"
          >
            {cover && <img src={cover} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />}
            <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition-opacity group-hover/cover:bg-black/35 group-hover/cover:opacity-100">
              {uploading ? <Loader2 className="size-5 animate-spin text-white" /> : <Camera className="size-5 text-white" />}
            </span>
          </button>
        )}
      </ImageUpload>

      <div className="px-6 pb-6">
        <ImageUpload onUploaded={(url) => update({ image: url })} aspect={1} cropShape="round" maxOutput={512} title="Crop avatar">
          {({ uploading, open: pick }) => (
            <button
              type="button"
              onClick={pick}
              aria-label="Change avatar"
              style={{ borderColor: "var(--popover)" }}
              className="group/av relative z-10 -mt-10 mb-3 grid size-[76px] place-items-center overflow-hidden rounded-2xl border-4 bg-popover"
            >
              {image ? (
                <img src={image} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="grid size-full place-items-center text-2xl font-semibold text-white" style={{ background: accentColor(accent) }}>
                  {initials(displayName || me.displayName)}
                </span>
              )}
              <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition-opacity group-hover/av:bg-black/40 group-hover/av:opacity-100">
                {uploading ? <Loader2 className="size-4 animate-spin text-white" /> : <Camera className="size-4 text-white" />}
              </span>
            </button>
          )}
        </ImageUpload>

        <SectionHeader title="Profile" />

        <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">Display name</label>
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} placeholder="Your name" className="bg-raised" />

        <label className="mt-3 mb-1.5 block text-[12px] font-medium text-muted-foreground">Username</label>
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-muted-foreground">@</span>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            maxLength={20}
            placeholder="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="bg-raised pl-7"
          />
        </div>
        <p className="mt-1 text-[11.5px] text-faint">Your unique @handle · lowercase letters, numbers, _ or . (3–20)</p>

        <label className="mt-3 mb-1.5 block text-[12px] font-medium text-muted-foreground">About</label>
        <Textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={3}
          maxLength={280}
          placeholder="A line or two about you…"
          className="resize-none bg-raised text-[13.5px]"
        />

        <label className="mt-4 mb-2 block text-[12px] font-medium text-muted-foreground">Accent</label>
        <div className="flex gap-2">
          {ACCENTS.map((h) => (
            <button
              key={h}
              type="button"
              aria-label={`accent ${h}`}
              onClick={() => setAccent(h)}
              className={cn(
                "grid size-7 place-items-center rounded-full transition-transform",
                accent === h ? "ring-2 ring-foreground ring-offset-2 ring-offset-popover" : "hover:scale-110",
              )}
              style={{ background: accentColor(h) }}
            >
              {accent === h && <Check className="size-3.5 text-white" />}
            </button>
          ))}
        </div>

        {error && <p className="mt-3 text-[12.5px] text-destructive">{error}</p>}

        <div className="mt-5 flex items-center justify-end gap-3">
          {saved && !busy && <span className="text-[12.5px] text-success">Saved</span>}
          <Button className="h-9 gap-2 bg-primary text-primary-foreground hover:bg-primary-hover" onClick={save} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save profile
          </Button>
        </div>
      </div>
    </div>
  );
}

function Switch({ on, busy, disabled, onClick }: { on: boolean; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled || busy}
      onClick={onClick}
      className={cn(
        "relative h-[26px] w-11 shrink-0 rounded-full transition-colors disabled:opacity-50",
        on ? "bg-primary" : "bg-muted-foreground/35",
      )}
    >
      <span className={cn("absolute top-0.5 grid size-[22px] place-items-center rounded-full bg-white transition-transform", on ? "translate-x-[20px]" : "translate-x-0.5")}>
        {busy && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </span>
    </button>
  );
}

export function NotificationsSection() {
  const config = useQuery(api.push.config, {}) as { enabled: boolean; publicKey: string } | undefined;
  const status = useQuery(api.push.status, {}) as { count: number } | undefined;
  const subscribe = useMutation(api.push.subscribe);
  const unsubscribe = useMutation(api.push.unsubscribe);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = pushSupported();
  const denied = permissionState() === "denied";
  const iosNeedsInstall =
    /iphone|ipad|ipod/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "") &&
    !(typeof window !== "undefined" && (window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone));

  useEffect(() => {
    let alive = true;
    currentSubscription().then((s) => alive && setSubscribed(!!s));
    return () => {
      alive = false;
    };
  }, []);

  async function enable() {
    if (!config?.publicKey) return;
    setBusy(true);
    setError(null);
    try {
      const keys = await subscribePush(config.publicKey);
      await subscribe({ ...keys, ua: navigator.userAgent });
      setSubscribed(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const endpoint = await unsubscribePush();
      if (endpoint) await unsubscribe({ endpoint });
      setSubscribed(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const count = status?.count ?? 0;

  return (
    <div className="p-6">
      <SectionHeader title="Notifications" desc="Get pinged for @mentions and replies — even when en's tab is closed." />

      {!supported ? (
        <p className="rounded-xl border border-border-strong bg-raised p-4 text-[13px] text-muted-foreground">
          This browser doesn't support push notifications.
        </p>
      ) : config && !config.enabled ? (
        <p className="rounded-xl border border-border-strong bg-raised p-4 text-[13px] text-muted-foreground">
          Push notifications aren't configured on the server yet.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border-strong bg-raised p-4">
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-foreground">Push notifications on this device</div>
              <div className="text-[12.5px] text-muted-foreground">
                {subscribed === null
                  ? "Checking…"
                  : subscribed
                    ? "Enabled"
                    : denied
                      ? "Blocked in your browser settings"
                      : "Off"}
                {count > 0 && ` · ${count} device${count === 1 ? "" : "s"} total`}
              </div>
            </div>
            <Switch
              on={!!subscribed}
              busy={busy || subscribed === null}
              disabled={denied || !config?.publicKey}
              onClick={() => (subscribed ? disable() : enable())}
            />
          </div>

          {denied && (
            <p className="mt-3 text-[12.5px] text-muted-foreground">
              You've blocked notifications for this site. Re-enable them in your browser's site settings, then toggle this on.
            </p>
          )}
          {iosNeedsInstall && (
            <p className="mt-3 text-[12.5px] text-muted-foreground">
              On iPhone/iPad, add en to your Home Screen first (Share → Add to Home Screen), then enable notifications from the installed app.
            </p>
          )}
          {error && <p className="mt-3 text-[12.5px] text-destructive">{error}</p>}
        </>
      )}
    </div>
  );
}

interface SessionRow {
  id: string;
  token: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string | number | Date;
}

function NameOfUA(ua?: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iphone|ipad|ipod/i.test(ua)
    ? "iOS"
    : /android/i.test(ua)
      ? "Android"
      : /mac os x|macintosh/i.test(ua)
        ? "macOS"
        : /windows/i.test(ua)
          ? "Windows"
          : /linux/i.test(ua)
            ? "Linux"
            : "";
  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /chrome|crios/i.test(ua)
      ? "Chrome"
      : /firefox|fxios/i.test(ua)
        ? "Firefox"
        : /safari/i.test(ua)
          ? "Safari"
          : "Browser";
  return os ? `${browser} on ${os}` : browser;
}

function relAgo(d: string | number | Date): string {
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  return day < 7 ? `${day}d ago` : new Date(d).toLocaleDateString();
}

export function SessionsSection() {
  const { data: current } = authClient.useSession();
  const currentId = (current?.session as { id?: string } | undefined)?.id;
  const currentToken = (current?.session as { token?: string } | undefined)?.token;
  const isMine = (s: SessionRow) => (!!currentId && s.id === currentId) || (!!currentToken && s.token === currentToken);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = (await authClient.listSessions()) as { data?: SessionRow[] | null };
      setSessions((res.data ?? []).slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function revoke(token: string) {
    setBusy(token);
    try {
      await authClient.revokeSession({ token });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    setBusy("others");
    try {
      await authClient.revokeOtherSessions();
      await reload();
    } finally {
      setBusy(null);
    }
  }

  const others = sessions?.filter((s) => !isMine(s)).length ?? 0;

  return (
    <div className="p-6">
      <SectionHeader title="Sessions" desc="Devices and browsers signed in to your account. Revoke any you don't recognise." />

      {sessions === null ? (
        <div className="grid place-items-center py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {sessions.map((s) => {
              const mine = isMine(s);
              return (
                <div key={s.id} className="flex items-center gap-3 rounded-xl border border-border-strong bg-raised p-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-elevated text-muted-foreground">
                    {/iphone|ipad|android/i.test(s.userAgent ?? "") ? <Smartphone className="size-[18px]" /> : <MonitorSmartphone className="size-[18px]" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
                      <span className="truncate">{NameOfUA(s.userAgent)}</span>
                      {mine && <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-primary">This device</span>}
                    </div>
                    <div className="truncate text-[12px] text-muted-foreground">
                      {(s.ipAddress && s.ipAddress.trim()) || "Unknown IP"} · {relAgo(s.createdAt)}
                    </div>
                  </div>
                  {!mine && (
                    <Button
                      variant="ghost"
                      className="h-8 shrink-0 text-[12.5px] text-muted-foreground hover:bg-destructive/12 hover:text-destructive"
                      onClick={() => revoke(s.token)}
                      disabled={busy === s.token}
                    >
                      {busy === s.token ? <Loader2 className="size-4 animate-spin" /> : "Revoke"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>

          {others > 0 && (
            <Button
              variant="ghost"
              className="mt-3 h-9 gap-2 text-destructive hover:bg-destructive/12"
              onClick={revokeOthers}
              disabled={busy === "others"}
            >
              {busy === "others" && <Loader2 className="size-4 animate-spin" />}
              Sign out all other devices
            </Button>
          )}
        </>
      )}
    </div>
  );
}
