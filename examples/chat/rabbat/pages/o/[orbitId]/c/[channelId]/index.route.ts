import { defineRoute } from "@rabbat/react";
import { tailWindow } from "@rabbat/protocol";

import { api } from "@/rabbat";

// Preload everything the channel view needs — orbit, sidebar lists, and the
// latest message window — so opening a channel renders populated instead of
// flashing a loading spinner. `params` ({ orbitId, channelId }) is typed from the
// route's `path`; `search` adds an optional `?at=` field ("jump to message").
export const Route = defineRoute({
  path: "/o/:orbitId/c/:channelId",
  ssr: false,
  // `?at=<messageId>` anchors the feed to a specific message ("jump to message").
  search: { at: undefined as string | undefined },
  loader: async ({ params, context }) => {
    await Promise.all([
      context.preload(api.orbits.get, { id: params.orbitId }),
      context.preload(api.channels.list, { orbitId: params.orbitId }),
      context.preload(api.categories.list, { orbitId: params.orbitId }),
      context.preload(api.messages.list, { channelId: params.channelId }, { pagination: tailWindow(40) }),
    ]);
  },
});

export const route = Route
