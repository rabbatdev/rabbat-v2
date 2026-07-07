import { useState } from "react";
import { Link, useMeta, useRouter } from "@rabbat/react";
import { useMutation, useQuery } from "@rabbat/react";
import { Loader2, Users } from "lucide-react";

import { api } from "@/rabbat";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage, initials } from "@/lib/util";

function orbitGradient(hue: number): string {
  return `linear-gradient(140deg, oklch(0.62 0.11 ${hue}), oklch(0.5 0.12 ${(hue + 30) % 360}))`;
}

export function InviteScreen({ code }: { code: string }) {
  const router = useRouter();
  const preview = useQuery(api.orbits.byInvite, { code });
  useMeta(preview?.name ? `Join ${preview.name}` : "Invite");
  const join = useMutation(api.orbits.join);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await join({ invite: code });
      void router.visit(`/o/${res.id}`, { clientOnly: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="atmos-app flex flex-1 items-center justify-center px-4 py-10">
      {preview === undefined ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : preview === null ? (
        <div className="animate-fade-up panel-card w-full max-w-[380px] p-8 text-center">
          <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-secondary text-2xl">🚫</div>
          <h1 className="text-[20px] font-semibold tracking-tight">Invite invalid or expired</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
            This invite link is invalid, has expired, or has reached its maximum number of uses.
          </p>
          <Button asChild variant="ghost" className="mt-5 h-10">
            <Link href="/" clientOnly>Back to en</Link>
          </Button>
        </div>
      ) : (
        <div className="animate-fade-up panel-card w-full max-w-[400px] overflow-hidden">
          <div
            className="relative h-[108px] overflow-hidden"
            style={preview.cover ? undefined : { background: orbitGradient(preview.hue) }}
          >
            {preview.cover && (
              <img
                src={preview.cover}
                alt=""
                className="size-full object-cover"
                referrerPolicy="no-referrer"
              />
            )}
            <span className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-card/95" />
          </div>

          <div className="px-6 pb-6 pt-0">
            <div className="-mt-9 mb-4">
              <span
                className={cn(
                  "relative z-10 grid size-[72px] place-items-center overflow-hidden rounded-2xl border-4 text-xl font-bold text-white",
                  !preview.icon && "text-white",
                )}
                style={{
                  borderColor: "var(--card)",
                  ...(preview.icon ? undefined : { background: orbitGradient(preview.hue) }),
                }}
              >
                {preview.icon ? (
                  <img src={preview.icon} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  initials(preview.name)
                )}
              </span>
            </div>

            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {preview.alreadyMember ? "You're already in" : "You've been invited to join"}
            </p>
            <h1 className="mt-1.5 text-[24px] font-semibold tracking-tight">{preview.name}</h1>
            <div className="mt-2 flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Users className="size-3.5" />
              {preview.memberCount} {preview.memberCount === 1 ? "member" : "members"}
            </div>

            {error && <p className="mt-3 text-[12.5px] text-destructive">{error}</p>}

            {preview.alreadyMember ? (
              <Button
                className="mt-6 h-11 w-full bg-primary text-primary-foreground hover:bg-primary-hover"
                onClick={() => void router.visit(`/o/${preview.id}`, { clientOnly: true })}
              >
                Open {preview.name}
              </Button>
            ) : (
              <Button
                className="mt-6 h-11 w-full gap-2 bg-primary text-primary-foreground hover:bg-primary-hover"
                onClick={accept}
                disabled={busy}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                Accept invite
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
