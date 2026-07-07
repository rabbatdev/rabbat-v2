import { useState } from "react";
import { useMeta, useRouter } from "@rabbat/react";
import { Loader2 } from "lucide-react";

import { api } from "@/rabbat";
import { useQuery } from "@rabbat/react";
import { getLastChannel } from "@/lib/last-location";
import { SettingsShell } from "./SettingsShell";
import {
  OrbitSettingsContent,
  orbitSettingsNav,
  type OrbitSettingsSection,
} from "./OrbitSettings";

/** Orbit settings as a full page (`/o/$orbitId/settings`). Self-contained: it
 *  fetches its own orbit, so it can render outside the orbit chrome. */
export function OrbitSettingsPage({ orbitId }: { orbitId: string }) {
  const orbit = useQuery(api.orbits.get, { id: orbitId });
  const router = useRouter();
  const [section, setSection] = useState<OrbitSettingsSection | null>(null);
  useMeta(orbit?.name ? `${orbit.name} · Settings` : "Orbit settings");
  // Back to the exact channel we left (cached → instant), not the orbit root
  // which would flash the empty-channel placeholder before auto-selecting.
  const close = () => {
    const channelId = getLastChannel(orbitId);
    if (channelId) void router.visit(`/o/${orbitId}/c/${channelId}`, { clientOnly: true });
    else void router.visit(`/o/${orbitId}`, { clientOnly: true });
  };

  if (orbit === undefined) {
    return (
      <div className="atmos-app fixed inset-0 z-50 grid place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (orbit === null) {
    return (
      <div className="atmos-app fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 px-8 text-center">
        <h1 className="text-lg font-semibold">Orbit unavailable</h1>
        <p className="max-w-xs text-sm text-muted-foreground">This orbit doesn't exist or you're not a member of it.</p>
        <button onClick={close} className="press mt-1 rounded-lg bg-accent px-4 py-2 text-[13.5px] font-medium hover:bg-elevated">
          Back
        </button>
      </div>
    );
  }

  const nav = orbitSettingsNav(orbit);
  const active = section ?? nav[0]?.key ?? "overview";

  return (
    <SettingsShell
      title="Orbit settings"
      nav={nav}
      active={active}
      onSelect={setSection}
      onClose={close}
    >
      <div key={active} className="animate-section">
        <OrbitSettingsContent section={active} orbit={orbit} />
      </div>
    </SettingsShell>
  );
}
