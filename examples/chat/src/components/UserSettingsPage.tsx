import { useState } from "react";
import { useMeta, useRouter } from "@rabbat/react";
import { LogOut } from "lucide-react";

import { useIdentity } from "@/context/identity";
import { getLastChannel, getLastOrbit } from "@/lib/last-location";
import { SettingsShell } from "./SettingsShell";
import {
  ProfileSection,
  NotificationsSection,
  SessionsSection,
  USER_SETTINGS_NAV,
  type UserSettingsSection,
} from "./ProfileModal";

/** Account settings as a full page (`/settings`). */
export function UserSettingsPage() {
  const me = useIdentity();
  const router = useRouter();
  const [section, setSection] = useState<UserSettingsSection>("profile");
  useMeta("Settings");

  // Go straight back to the chat we came from (cached → no spinner), rather than
  // through "/" which re-runs the orbit/channel redirect chain.
  const close = () => {
    const orbitId = getLastOrbit();
    const channelId = orbitId ? getLastChannel(orbitId) : null;
    if (orbitId && channelId) void router.visit(`/o/${orbitId}/c/${channelId}`, { clientOnly: true });
    else if (orbitId) void router.visit(`/o/${orbitId}`, { clientOnly: true });
    else void router.visit("/", { clientOnly: true });
  };

  return (
    <SettingsShell
      title="Settings"
      nav={USER_SETTINGS_NAV}
      active={section}
      onSelect={setSection}
      onClose={close}
      footer={
        <button
          onClick={me.signOut}
          className="press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-destructive/12 hover:text-destructive [&_svg]:size-4"
        >
          <LogOut />
          Sign out
        </button>
      }
    >
      <div key={section} className="animate-section">
        {section === "profile" && <ProfileSection />}
        {section === "notifications" && <NotificationsSection />}
        {section === "sessions" && <SessionsSection />}
      </div>
    </SettingsShell>
  );
}
