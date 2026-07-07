import { InviteScreen } from "@/components/InviteScreen";

import { Route } from "./index.route";

export default function InvitePage() {
  const { code } = Route.useParams();
  return <InviteScreen code={code} />;
}
