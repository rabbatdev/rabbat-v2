import { defineRoute } from "@rabbat/react";

import { api } from "@/rabbat";

// Data-driven Open Graph for shared invite links: the orbit name comes from the
// public `invites.meta` query (built with `publicQuery`, so no sign-in). The
// loader runs it (server-side on first/direct load, so the <head> a crawler /
// link unfurler reads is populated), then `meta` turns it into the merged tags.
// An unknown or expired code returns `{}`, falling back to the default tags.
// `params.code` is typed from the route's `path`.
export const Route = defineRoute({
  path: "/invite/:code",
  ssr: false,
  loader: async ({ params, context }) => {
    const { orbitName } = await context.runQuery(api.invites.meta, { code: params.code });
    return { orbitName };
  },
  meta: ({ data }) => {
    if (!data?.orbitName) return {};
    const title = `Join ${data.orbitName} on en`;
    return {
      title,
      tags: [
        {
          name: "description",
          content: "You've been invited to an orbit. Tap to accept and start chatting.",
        },
        { property: "og:title", content: title },
        { property: "og:image", content: "/og-invite.png" },
      ],
    };
  },
});

export const route = Route
