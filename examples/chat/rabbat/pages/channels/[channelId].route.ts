import { defineRoute } from "@rabbat/react"
import { tailWindow } from "@rabbat/protocol"
import { api } from "../../_generated/api.js"

export const route = defineRoute({
  path: "/channels/:channelId",
  // Preload the channel's messages so the feed renders with data, no flash.
  // `params.channelId` is typed from the path — no schema, no magic import.
  loader: ({ params, context }) =>
    context.preload(api.messages.list, { channelId: params.channelId }, { pagination: tailWindow(30) }),
  meta: ({ params }) => ({ title: `#${params.channelId.replace(/^chan-/, "")}` }),
  // Client-side navigation between channels; still SSR'd on first/direct load.
  ssr: false,
})
