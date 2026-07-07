import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@rabbat/react";

import { api } from "@/rabbat";
import { roleTint } from "@/lib/util";
import { MemberCard } from "@/components/MembersRail";

interface MemberCardCtx {
  /** Open the member profile card for a user id (no-op if not an orbit member). */
  open: (userId: string) => void;
  /** A member's role-tint colour for their name (undefined → default colour). */
  roleColorOf: (userId: string) => string | undefined;
}

const Context = createContext<MemberCardCtx | null>(null);

export function useMemberCard(): MemberCardCtx {
  const c = useContext(Context);
  if (!c) throw new Error("useMemberCard must be used within MemberCardProvider");
  return c;
}

/** Orbit-scoped: loads the member list once and opens the shared MemberCard for
 *  any user id — so the members rail AND message authors open the same card. */
export function MemberCardProvider({ orbitId, children }: { orbitId: string; children: ReactNode }) {
  const members = useQuery(api.members.list, { orbitId });
  const [openId, setOpenId] = useState<string | null>(null);
  const member = openId ? (members?.find((m) => m.userId === openId) ?? null) : null;

  const tints = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of members ?? []) {
      const t = roleTint(x.isOwner ? "45" : x.roleColor);
      if (t) m.set(x.userId, t);
    }
    return m;
  }, [members]);
  const roleColorOf = useCallback((userId: string) => tints.get(userId), [tints]);

  return (
    <Context.Provider value={{ open: setOpenId, roleColorOf }}>
      {children}
      {member && <MemberCard orbitId={orbitId} member={member} onClose={() => setOpenId(null)} />}
    </Context.Provider>
  );
}
