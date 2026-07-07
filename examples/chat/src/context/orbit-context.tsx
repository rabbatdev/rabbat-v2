import { createContext, useContext } from "react";

import type { OrbitDetail } from "@/rabbat";

/** The current orbit + the caller's membership — exactly what `api.orbits.get`
 *  returns (derived, so it can't drift from the query). */
export type OrbitInfo = OrbitDetail;

export const OrbitContext = createContext<OrbitInfo | null>(null);

/** The current orbit (with the caller's permissions). Null outside an orbit. */
export function useOrbit(): OrbitInfo | null {
  return useContext(OrbitContext);
}
