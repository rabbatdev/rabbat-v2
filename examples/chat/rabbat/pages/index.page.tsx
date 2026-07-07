import { useEffect } from "react";
import { useQuery, useRouter } from "@rabbat/react";
import { Loader2 } from "lucide-react";

import { api, type Orbit } from "@/rabbat";
import { Onboarding } from "@/components/Onboarding";
import { getLastOrbit } from "@/lib/last-location";

function Spinner() {
  return (
    <div className="flex flex-1 items-center justify-center bg-background text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
    </div>
  );
}

// Home: drop into the orbit you last had open (or your most recent), else onboard.
export default function Home() {
  const orbits = useQuery(api.orbits.listMine, {}) as Orbit[] | undefined;
  const router = useRouter();
  useEffect(() => {
    if (orbits && orbits.length > 0) {
      const last = getLastOrbit();
      const orbitId = last && orbits.some((o) => o.id === last) ? last : orbits[orbits.length - 1].id;
      void router.visit(`/o/${orbitId}`, { clientOnly: true });
    }
  }, [orbits, router]);
  if (orbits === undefined) return <Spinner />;
  if (orbits.length === 0) return <Onboarding />;
  return <Spinner />;
}
