import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@rabbat/react";
import {
  Camera,
  Check,
  Link2,
  Loader2,
  Plus,
  Shield,
  SlidersHorizontal,
  Smile,
  Trash2,
} from "lucide-react";

import { api, type CustomEmoji, type Role } from "@/rabbat";
import type { OrbitInfo } from "@/context/orbit-context";
import { Perm, hasPerm } from "@/lib/perms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ImageUpload } from "./ImageUpload";
import { InviteManager } from "./InviteManager";
import { useConfirm } from "./ConfirmDialog";
import { cn } from "@/lib/utils";
import { errorMessage, initials, roleTint } from "@/lib/util";

const PERMS: { flag: number; label: string; desc: string }[] = [
  { flag: Perm.MANAGE_ORBIT, label: "Manage orbit", desc: "Edit name and cover" },
  { flag: Perm.CREATE_INVITE, label: "Create invites", desc: "Create and manage invite links" },
  { flag: Perm.MANAGE_CHANNELS, label: "Manage channels", desc: "Create, edit & delete channels and categories" },
  { flag: Perm.MANAGE_MESSAGES, label: "Manage messages", desc: "Delete anyone's messages" },
  { flag: Perm.MANAGE_ROLES, label: "Manage roles", desc: "Create, edit, and assign roles" },
  { flag: Perm.KICK_MEMBERS, label: "Kick members", desc: "Remove members from the orbit" },
  { flag: Perm.MANAGE_EMOJI, label: "Manage emoji", desc: "Create and delete custom emoji" },
];

const ROLE_HUES = ["0", "25", "45", "90", "150", "190", "230", "275", "320"];

export type OrbitSettingsSection = "overview" | "invites" | "roles" | "emoji";

/** Which settings sections this member is allowed to see, in display order. */
export function orbitSettingsNav(
  orbit: OrbitInfo,
): { key: OrbitSettingsSection; label: string; icon: React.ReactNode }[] {
  return [
    hasPerm(orbit, Perm.MANAGE_ORBIT) && { key: "overview" as const, label: "Overview", icon: <SlidersHorizontal /> },
    hasPerm(orbit, Perm.CREATE_INVITE) && { key: "invites" as const, label: "Invites", icon: <Link2 /> },
    hasPerm(orbit, Perm.MANAGE_EMOJI) && { key: "emoji" as const, label: "Emoji", icon: <Smile /> },
    hasPerm(orbit, Perm.MANAGE_ROLES) && { key: "roles" as const, label: "Roles", icon: <Shield /> },
  ].filter(Boolean) as { key: OrbitSettingsSection; label: string; icon: React.ReactNode }[];
}

/** Renders a single orbit-settings section (the page supplies the chrome). */
export function OrbitSettingsContent({ section, orbit }: { section: OrbitSettingsSection; orbit: OrbitInfo }) {
  return (
    <>
      {section === "overview" && <OverviewSection orbit={orbit} />}
      {section === "invites" && <InvitesSection orbit={orbit} />}
      {section === "emoji" && <EmojiSection orbit={orbit} />}
      {section === "roles" && <RolesSection orbitId={orbit.id} />}
    </>
  );
}

function orbitGradient(hue: number): string {
  return `linear-gradient(140deg, oklch(0.62 0.11 ${hue}), oklch(0.5 0.12 ${(hue + 30) % 360}))`;
}

function SectionHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
      {desc && <p className="mt-1 text-[13px] text-muted-foreground">{desc}</p>}
    </div>
  );
}

function OverviewSection({ orbit }: { orbit: OrbitInfo }) {
  const update = useMutation(api.orbits.update);
  const [name, setName] = useState(orbit.name);
  const [busy, setBusy] = useState(false);

  useEffect(() => setName(orbit.name), [orbit.name]);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === orbit.name) return;
    setBusy(true);
    try {
      await update({ orbitId: orbit.id, name: name.trim() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* Cover banner — the orbit icon lives on the sidebar, so it isn't edited here. */}
      <ImageUpload
        onUploaded={(url) => update({ orbitId: orbit.id, cover: url })}
        aspect={3}
        maxOutput={1280}
        title="Crop orbit cover"
      >
        {({ uploading, open: pick }) => (
          <button
            type="button"
            onClick={pick}
            className="group/cover relative block h-32 w-full overflow-hidden"
            style={orbit.cover ? undefined : { background: orbitGradient(orbit.hue) }}
            aria-label="Change cover photo"
          >
            {orbit.cover && <img src={orbit.cover} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />}
            <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition-opacity group-hover/cover:bg-black/35 group-hover/cover:opacity-100">
              {uploading ? <Loader2 className="size-5 animate-spin text-white" /> : (
                <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-white">
                  <Camera className="size-4" /> Change cover
                </span>
              )}
            </span>
          </button>
        )}
      </ImageUpload>

      <div className="p-6">
        {/* Orbit icon (shows in the rail) — uploadable here. */}
        <ImageUpload
          onUploaded={(url) => update({ orbitId: orbit.id, icon: url })}
          aspect={1}
          maxOutput={512}
          title="Crop orbit icon"
        >
          {({ uploading, open: pick }) => (
            <button
              type="button"
              onClick={pick}
              aria-label="Change orbit icon"
              className="group/icon relative z-10 -mt-14 mb-4 grid size-[76px] place-items-center overflow-hidden rounded-2xl border-4"
              style={{ borderColor: "var(--popover)", ...(orbit.icon ? null : { background: orbitGradient(orbit.hue) }) }}
            >
              {orbit.icon ? (
                <img src={orbit.icon} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="text-2xl font-bold text-white">{initials(orbit.name)}</span>
              )}
              <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition-opacity group-hover/icon:bg-black/40 group-hover/icon:opacity-100">
                {uploading ? <Loader2 className="size-4 animate-spin text-white" /> : <Camera className="size-4 text-white" />}
              </span>
            </button>
          )}
        </ImageUpload>

        <SectionHeader title="Overview" />
        <form onSubmit={saveName}>
          <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">Orbit name</label>
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-10 bg-raised" />
            <Button
              type="submit"
              disabled={busy || !name.trim() || name.trim() === orbit.name}
              className="h-10 gap-2 bg-primary text-primary-foreground hover:bg-primary-hover"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function InvitesSection({ orbit }: { orbit: OrbitInfo }) {
  return (
    <div className="p-6">
      <SectionHeader
        title="Invites"
        desc="Create links that can expire or cap how many people use them. Revoke any link anytime."
      />
      <InviteManager orbitId={orbit.id} />
    </div>
  );
}

function EmojiSection({ orbit }: { orbit: OrbitInfo }) {
  const list = useQuery(api.emoji.list, { orbitId: orbit.id });
  const create = useMutation(api.emoji.create);
  const remove = useMutation(api.emoji.remove);
  const { confirm, confirmDialog } = useConfirm();
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!pendingUrl || name.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      await create({ orbitId: orbit.id, name: name.trim(), url: pendingUrl });
      setPendingUrl(null);
      setName("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(em: CustomEmoji) {
    if (await confirm({ title: `Delete :${em.name}:?`, confirmLabel: "Delete", destructive: true })) {
      try {
        await remove({ id: em.id });
      } catch (e) {
        alert(errorMessage(e));
      }
    }
  }

  return (
    <div className="p-6">
      <SectionHeader title="Emoji" desc="Upload custom emoji for this orbit — use them in messages as :name: or as reactions." />

      {pendingUrl ? (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-border-strong bg-raised p-3">
          <img src={pendingUrl} alt="" className="size-12 shrink-0 rounded-lg bg-background object-contain p-1" referrerPolicy="no-referrer" />
          <div className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">
            <span>:</span>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="name"
              maxLength={32}
              className="h-9 bg-background"
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <span>:</span>
          </div>
          <Button variant="ghost" className="h-9" onClick={() => { setPendingUrl(null); setName(""); }} disabled={busy}>
            Cancel
          </Button>
          <Button
            className="h-9 gap-2 bg-primary text-primary-foreground hover:bg-primary-hover"
            disabled={busy || name.trim().length < 2}
            onClick={add}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Add
          </Button>
        </div>
      ) : (
        <ImageUpload
          onUploaded={(url) => setPendingUrl(url)}
          onError={(m) => setError(m)}
          aspect={1}
          maxOutput={128}
          title="Crop emoji"
        >
          {({ uploading, open }) => (
            <Button
              variant="ghost"
              onClick={open}
              disabled={uploading}
              className="mb-4 h-11 w-full justify-center gap-2 border border-dashed border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Upload emoji
            </Button>
          )}
        </ImageUpload>
      )}

      {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}

      <div className="space-y-0.5">
        {(list ?? []).map((em) => (
          <div key={em.id} className="group/emoji flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent">
            <img src={em.url} alt="" className="size-7 shrink-0 rounded object-contain" referrerPolicy="no-referrer" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">:{em.name}:</span>
            <button
              type="button"
              aria-label={`Delete ${em.name}`}
              onClick={() => onRemove(em)}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-destructive/15 hover:text-destructive focus:opacity-100 group-hover/emoji:opacity-100"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        {list && list.length === 0 && !pendingUrl && (
          <p className="py-8 text-center text-[13px] text-muted-foreground">No custom emoji yet — upload one above.</p>
        )}
      </div>
      {confirmDialog}
    </div>
  );
}

function RolesSection({ orbitId }: { orbitId: string }) {
  const roles = useQuery(api.roles.list, { orbitId });
  const [editing, setEditing] = useState<Role | "new" | null>(null);

  if (editing) {
    return <RoleEditor orbitId={orbitId} role={editing === "new" ? null : editing} onDone={() => setEditing(null)} />;
  }

  return (
    <div className="p-6">
      <SectionHeader title="Roles" desc="Roles grant permissions and color members' names." />
      <div className="space-y-0.5">
        {(roles ?? []).map((r) => (
          <button
            key={r.id}
            onClick={() => setEditing(r)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent"
          >
            <span
              className="size-3 shrink-0 rounded-full ring-1 ring-inset ring-white/15"
              style={{ background: roleTint(r.color) ?? "var(--muted-foreground)" }}
            />
            <span className="flex-1 text-[13.5px] font-medium" style={{ color: roleTint(r.color) }}>
              {r.name}
            </span>
            <span className="text-[12px] text-muted-foreground">{permSummary(r.permissions)}</span>
          </button>
        ))}
      </div>
      <Button
        variant="ghost"
        className="mt-2 h-9 w-full justify-start gap-2 text-primary hover:bg-primary/10"
        onClick={() => setEditing("new")}
      >
        <Plus className="size-4" />
        New role
      </Button>
    </div>
  );
}

function permSummary(permissions: number): string {
  if (permissions === 0) return "No permissions";
  const n = PERMS.filter((p) => (permissions & p.flag) !== 0).length;
  return `${n} permission${n === 1 ? "" : "s"}`;
}

function RoleEditor({ orbitId, role, onDone }: { orbitId: string; role: Role | null; onDone: () => void }) {
  const create = useMutation(api.roles.create);
  const update = useMutation(api.roles.update);
  const remove = useMutation(api.roles.remove);
  const { confirm, confirmDialog } = useConfirm();
  const [name, setName] = useState(role?.name ?? "");
  const [color, setColor] = useState<string | null>(role?.color ?? null);
  const [perms, setPerms] = useState<number>(role?.permissions ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMember = role?.name === "Member";

  function toggle(flag: number) {
    setPerms((p) => (p & flag ? p & ~flag : p | flag));
  }

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (role) await update({ roleId: role.id, name: name.trim(), color: color ?? "", permissions: perms });
      else await create({ orbitId, name: name.trim(), color: color ?? undefined, permissions: perms });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function onRemove() {
    if (!role) return;
    if (
      await confirm({
        title: `Delete the ${role.name} role?`,
        description: "Members with this role will fall back to the default role.",
        confirmLabel: "Delete role",
        destructive: true,
      })
    ) {
      try {
        await remove({ roleId: role.id });
        onDone();
      } catch (err) {
        setError(errorMessage(err));
      }
    }
  }

  return (
    <div className="p-6">
      <button onClick={onDone} className="mb-3 text-[12px] text-muted-foreground hover:text-foreground">
        ← Back to roles
      </button>

      <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">Role name</label>
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={isMember} placeholder="Moderator" className="h-10 bg-raised" />

      <label className="mb-2 mt-4 block text-[12px] font-medium text-muted-foreground">Color</label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="No color"
          onClick={() => setColor(null)}
          className={cn(
            "grid size-7 place-items-center rounded-full bg-muted text-[10px] text-muted-foreground transition-transform",
            color == null ? "ring-2 ring-foreground ring-offset-2 ring-offset-popover" : "hover:scale-110",
          )}
        >
          {color == null ? <Check className="size-3.5 text-foreground" /> : "—"}
        </button>
        {ROLE_HUES.map((h) => (
          <button
            key={h}
            type="button"
            aria-label={`color ${h}`}
            onClick={() => setColor(h)}
            className={cn(
              "grid size-7 place-items-center rounded-full transition-transform",
              color === h ? "ring-2 ring-foreground ring-offset-2 ring-offset-popover" : "hover:scale-110",
            )}
            style={{ background: roleTint(h) }}
          >
            {color === h && <Check className="size-3.5 text-black/80" />}
          </button>
        ))}
      </div>

      <label className="mb-2 mt-4 block text-[12px] font-medium text-muted-foreground">Permissions</label>
      <div className="space-y-1.5">
        {PERMS.map((p) => {
          const on = (perms & p.flag) !== 0;
          return (
            <button
              key={p.flag}
              type="button"
              onClick={() => toggle(p.flag)}
              className="flex w-full items-center gap-3 rounded-lg bg-raised px-3 py-2 text-left transition-colors hover:bg-elevated"
            >
              <Shield className={cn("size-4 shrink-0", on ? "text-primary" : "text-muted-foreground")} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-foreground">{p.label}</span>
                <span className="block truncate text-[11.5px] text-muted-foreground">{p.desc}</span>
              </span>
              <Switch on={on} />
            </button>
          );
        })}
      </div>

      {error && <p className="mt-3 text-[12.5px] text-destructive">{error}</p>}

      <div className="mt-5 flex items-center justify-between gap-2">
        {role && !isMember ? (
          <Button variant="ghost" className="h-9 gap-2 text-destructive hover:bg-destructive/12" onClick={onRemove}>
            <Trash2 className="size-4" />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" className="h-9" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
          <Button
            className="h-9 gap-2 bg-primary text-primary-foreground hover:bg-primary-hover"
            onClick={save}
            disabled={busy || !name.trim()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {role ? "Save role" : "Create role"}
          </Button>
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <span className={cn("relative h-[18px] w-8 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/35")}>
      <span className={cn("absolute top-0.5 size-[14px] rounded-full bg-white transition-transform", on ? "translate-x-[15px]" : "translate-x-0.5")} />
    </span>
  );
}
