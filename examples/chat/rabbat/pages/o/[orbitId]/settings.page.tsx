import { useParams } from "@rabbat/react";

import { OrbitSettingsPage } from "@/components/OrbitSettingsPage";

// Full-page orbit settings (rendered standalone, not inside the OrbitView shell).
export default function OrbitSettingsRoute() {
  const { orbitId } = useParams<{ orbitId: string }>();
  return <OrbitSettingsPage orbitId={orbitId} />;
}
