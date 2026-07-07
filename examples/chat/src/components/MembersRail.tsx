import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@rabbat/react";
import { Crown, Loader2, ShieldCheck, User, UserMinus } from "lucide-react";

import { api, type Member } from "@/rabbat";
import { useIdentity } from "@/context/identity";
import { useOrbit } from "@/context/orbit-context";
import { useMobileNav } from "@/context/mobile-nav";
import { Perm, hasPerm } from "@/lib/perms";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useConfirm } from "./ConfirmDialog";
import { useContextMenu, type MenuItem } from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useMemberCard } from "@/context/member-card";
import { StatusDot } from "./UserMenu";
import { cn } from "@/lib/utils";
import { initials, roleTint, statusMeta, userColor } from "@/lib/util";

export type { Member };

export function MembersRail({ orbitId }: { orbitId: string }) {
  const members = useQuery(api.members.list, { orbitId });
  const roles = useQuery(api.roles.list, { orbitId });
  const me = useIdentity();
  const orbit = useOrbit();
  const openMenu = useContextMenu();
  const setRole = useMutation(api.members.setRole);
  const kick = useMutation(api.members.kick);
  const { confirm, confirmDialog } = useConfirm();
  const { rightOpen } = useMobileNav();
  const { open: openMember } = useMemberCard();

  const canManageRoles = hasPerm(orbit, Perm.MANAGE_ROLES);
  const canKickAny = hasPerm(orbit, Perm.KICK_MEMBERS);

  function memberMenu(m: Member): MenuItem[] {
    const actionable = !m.isOwner && m.userId !== me.userId;
    const items: MenuItem[] = [
      { type: "label", label: m.name },
      { label: "View profile", icon: <User />, onSelect: () => openMember(m.userId) },
    ];
    if (canManageRoles && actionable && roles && roles.length > 0) {
      items.push({ type: "separator" }, { type: "label", label: "Set role" });
      for (const r of roles) {
        items.push({
          label: m.roleId === r.id ? `${r.name} ✓` : r.name,
          disabled: m.roleId === r.id,
          onSelect: () => void setRole({ orbitId, userId: m.userId, roleId: r.id }),
        });
      }
    }
    if (canKickAny && actionable) {
      items.push({ type: "separator" });
      items.push({
        label: "Remove from orbit",
        icon: <UserMinus />,
        destructive: true,
        onSelect: () => void kickMember(m),
      });
    }
    return items;
  }

  async function kickMember(m: Member) {
    if (
      await confirm({
        title: `Remove ${m.name}?`,
        description: "They'll lose access to this orbit but can rejoin with an invite.",
        confirmLabel: "Remove",
        destructive: true,
      })
    ) {
      await kick({ orbitId, userId: m.userId });
    }
  }

  const { online, offline } = useMemo(() => {
    const ms = (members ?? []).slice().sort((a, b) => {
      if (a.rolePosition !== b.rolePosition) return a.rolePosition - b.rolePosition;
      return a.name.localeCompare(b.name);
    });
    return { online: ms.filter((m) => m.online), offline: ms.filter((m) => !m.online) };
  }, [members]);

  // Online members grouped by role (Owner first), then everyone offline.
  const onlineGroups = useMemo(() => {
    const groups: { name: string; members: Member[] }[] = [];
    for (const m of online) {
      const last = groups[groups.length - 1];
      if (last && last.name === m.roleName) last.members.push(m);
      else groups.push({ name: m.roleName, members: [m] });
    }
    return groups;
  }, [online]);

  return (
    <aside
      className={cn(
        "atmos-rail flex shrink-0 flex-col overflow-hidden border-l border-border-strong bg-rail",
        // Mobile: a full-screen drawer that slides in from the right, behind the
        // chat (z-10), pinned below the safe area.
        "fixed right-0 top-[var(--sat)] z-10 h-[calc(var(--app-h)_-_var(--sat))] w-[85vw] transition-transform duration-300 ease-out",
        rightOpen ? "translate-x-0" : "translate-x-full",
        // Desktop: in-flow column whose width toggles 0 ↔ 228 so chat reflows beside it.
        "md:static md:top-auto md:z-auto md:h-auto md:w-0 md:translate-x-0 md:transition-[width] md:duration-200",
        rightOpen ? "md:w-[228px]" : "md:border-l-0",
      )}
    >
      <div className="flex w-full flex-1 flex-col md:w-[228px] md:min-w-[228px]">
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-0.5 px-2 pt-3 pb-[max(0.75rem,var(--sab))]">
          {members === undefined &&
            Array.from({ length: 7 }).map((_, i) => (
              <div key={`sk-${i}`} className="flex items-center gap-2.5 px-2 py-1.5">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <Skeleton className="h-3.5" style={{ width: [96, 72, 110, 64, 88, 76, 100][i % 7] }} />
              </div>
            ))}
          {onlineGroups.map((g) => (
            <Section key={`on-${g.name}`} label={`${g.name} — ${g.members.length}`}>
              {g.members.map((m) => (
                <MemberRow
                  key={m.userId}
                  m={m}
                  onClick={() => openMember(m.userId)}
                  onContext={(e) => openMenu(e, memberMenu(m))}
                />
              ))}
            </Section>
          ))}
          {offline.length > 0 && (
            <Section label={`Offline — ${offline.length}`}>
              {offline.map((m) => (
                <MemberRow
                  key={m.userId}
                  m={m}
                  dimmed
                  onClick={() => openMember(m.userId)}
                  onContext={(e) => openMenu(e, memberMenu(m))}
                />
              ))}
            </Section>
          )}
        </div>
      </ScrollArea>
      {confirmDialog}
      </div>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 first:mt-0">
      <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </h3>
      {children}
    </div>
  );
}

function Avatar({ m, size = 30 }: { m: Member; size?: number }) {
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      {m.image ? (
        <img
          src={m.image}
          alt=""
          referrerPolicy="no-referrer"
          className="size-full rounded-full object-cover ring-1 ring-border-strong"
        />
      ) : (
        <span
          className="grid size-full place-items-center rounded-full text-[11px] font-semibold text-white/95"
          style={{ background: userColor(m.accent, m.name), boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)" }}
        >
          {initials(m.name)}
        </span>
      )}
      <StatusDot
        status={m.status}
        size={11}
        surface="var(--rail)"
        className="absolute -bottom-0.5 -right-0.5"
      />
    </span>
  );
}

function MemberRow({
  m,
  dimmed,
  onClick,
  onContext,
}: {
  m: Member;
  dimmed?: boolean;
  onClick: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  const tint = roleTint(m.isOwner ? "45" : m.roleColor);
  return (
    <button
      onClick={onClick}
      onContextMenu={onContext}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left transition-colors hover:bg-accent/70",
        dimmed && "opacity-55 hover:opacity-100",
      )}
    >
      <Avatar m={m} />
      <span
        className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground/90"
        style={tint ? { color: tint } : undefined}
      >
        {m.name}
      </span>
      {m.isOwner && <Crown className="size-3.5 shrink-0 text-amber-400" />}
    </button>
  );
}

export function MemberCard({
  orbitId,
  member,
  onClose,
}: {
  orbitId: string;
  member: Member;
  onClose: () => void;
}) {
  const me = useIdentity();
  const orbit = useOrbit();
  const roles = useQuery(api.roles.list, { orbitId });
  const setRole = useMutation(api.members.setRole);
  const kick = useMutation(api.members.kick);
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);

  const canRoles = hasPerm(orbit, Perm.MANAGE_ROLES) && !member.isOwner && member.userId !== me.userId;
  const canKick = hasPerm(orbit, Perm.KICK_MEMBERS) && !member.isOwner && member.userId !== me.userId;

  async function changeRole(roleId: string) {
    setBusy(true);
    try {
      await setRole({ orbitId, userId: member.userId, roleId });
      onClose();
    } finally {
      setBusy(false);
    }
  }
  async function onKick() {
    if (
      await confirm({
        title: `Remove ${member.name}?`,
        description: "They'll lose access to this orbit but can rejoin with an invite.",
        confirmLabel: "Remove",
        destructive: true,
      })
    ) {
      await kick({ orbitId, userId: member.userId });
      onClose();
    }
  }

  return (
    <Modal open onClose={onClose} className="max-w-[380px] overflow-hidden p-0">
      {/* Cover photo (their banner), falling back to their accent gradient. */}
      <div className="h-20" style={member.cover ? undefined : { background: userColor(member.accent, member.name) }}>
        {member.cover && (
          <img src={member.cover} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
        )}
      </div>
      <div className="px-5 pb-5">
        <div className="-mt-9 mb-3">
          <span
            className="relative z-10 grid size-[68px] place-items-center overflow-hidden rounded-2xl border-4 bg-popover"
            style={{ borderColor: "var(--popover)" }}
          >
            {member.image ? (
              <img src={member.image} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
            ) : (
              <span
                className="grid size-full place-items-center text-xl font-semibold text-white"
                style={{ background: userColor(member.accent, member.name) }}
              >
                {initials(member.name)}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <h2 className="text-[17px] font-semibold tracking-tight">{member.name}</h2>
          {member.isOwner && <Crown className="size-4 text-amber-400" />}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <StatusDot status={member.status} size={8} surface="var(--popover)" />
          {statusMeta(member.status).label}
          <span className="mx-1">·</span>
          <ShieldCheck className="size-3.5" />
          {member.roleName}
        </div>

        {member.bio && (
          <div className="mt-4 rounded-lg bg-rail p-3">
            <p className="text-[13px] leading-relaxed text-foreground/85">{member.bio}</p>
          </div>
        )}

        {(canRoles || canKick) && (
          <div className="mt-4 space-y-2 border-t border-border pt-4">
            {canRoles && (
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-muted-foreground">Role</span>
                <Select
                  value={member.roleId}
                  disabled={busy}
                  onChange={changeRole}
                  ariaLabel="Member role"
                  options={(roles ?? []).map((r) => ({ value: r.id, label: r.name }))}
                  className="ml-auto h-8 w-[150px]"
                />
              </div>
            )}
            {canKick && (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2 text-destructive hover:bg-destructive/12"
                onClick={onKick}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <UserMinus className="size-4" />}
                Remove from orbit
              </Button>
            )}
          </div>
        )}
      </div>
      {confirmDialog}
    </Modal>
  );
}
