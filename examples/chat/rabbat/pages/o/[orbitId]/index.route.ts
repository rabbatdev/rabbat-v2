import { defineRoute } from "@rabbat/react";

import { api } from "@/rabbat";

// Preload the orbit + its sidebar lists so entering an orbit renders populated
// instead of flashing OrbitView's full-pane spinner. `params.orbitId` is typed
// (`{ orbitId: string }`) from the route's `path`; the same query keys then go
// live on the client.
export const Route = defineRoute({
  path: "/o/:orbitId",
  ssr: false,
  loader: async ({ params, context }) => {
    await Promise.all([
      context.preload(api.orbits.get, { id: params.orbitId }),
      context.preload(api.channels.list, { orbitId: params.orbitId }),
      context.preload(api.categories.list, { orbitId: params.orbitId }),
    ]);
  },
});

export const route = Route
