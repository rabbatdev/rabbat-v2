import { useEffect } from "react";

import { OrbitView } from "@/components/OrbitView";
import { ChatPanel } from "@/components/ChatPanel";
import { rememberLocation } from "@/lib/last-location";

import { Route } from "./index.route";

export default function ChannelPage() {
  const { orbitId, channelId } = Route.useParams();
  // `?at=<messageId>` anchors the feed to a specific message ("jump to message").
  const { at } = Route.useSearch();
  // Remember this spot so a reload / orbit-switch reopens right here.
  useEffect(() => rememberLocation(orbitId, channelId), [orbitId, channelId]);
  return (
    <OrbitView orbitId={orbitId}>
      <ChatPanel key={channelId} orbitId={orbitId} channelId={channelId} anchor={at ?? null} />
    </OrbitView>
  );
}
