import { OrbitView } from "@/components/OrbitView";

import { Route } from "./index.route";

// The orbit shell with no channel selected (OrbitView shows a placeholder).
export default function OrbitIndex() {
  const { orbitId } = Route.useParams();
  return <OrbitView orbitId={orbitId} />;
}
