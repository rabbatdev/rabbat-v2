import { defineRoute } from "@rabbat/react";

// Full-page orbit settings (rendered standalone, not inside the OrbitView shell).
export const Route = defineRoute({ path: "/o/:orbitId/settings", ssr: false });

export const route = Route
