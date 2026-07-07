import { useState, type FormEvent } from "react";
import { useRouter } from "@rabbat/react";
import { useMutation } from "@rabbat/react";
import { Loader2, Plus, Sparkles } from "lucide-react";

import { api } from "@/rabbat";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/util";

type Tab = "create" | "join";

function OrbitForm({ onDone }: { onDone: (orbitId: string) => void }) {
  const create = useMutation(api.orbits.create);
  const join = useMutation(api.orbits.join);
  const [tab, setTab] = useState<Tab>("create");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        tab === "create" ? await create({ name: value.trim() }) : await join({ invite: value.trim() });
      onDone(res.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="mb-4 flex gap-1 rounded-lg bg-rail p-1">
        {(["create", "join"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setError(null);
            }}
            className={cn(
              "flex-1 rounded-md py-1.5 text-[13px] font-medium capitalize transition-colors",
              tab === t ? "bg-elevated text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "create" ? "Create" : "Join"}
          </button>
        ))}
      </div>

      <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
        {tab === "create" ? "Orbit name" : "Invite code"}
      </label>
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={tab === "create" ? "Acme HQ" : "e.g. 7QK2ZP"}
        className="h-10 bg-raised"
      />
      {error && <p className="mt-2 text-[12.5px] text-destructive">{error}</p>}

      <Button
        type="submit"
        disabled={busy || !value.trim()}
        className="mt-4 h-10 w-full gap-2 bg-primary text-primary-foreground hover:bg-primary-hover"
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        {tab === "create" ? "Create orbit" : "Join orbit"}
      </Button>
    </form>
  );
}

/** Full-screen first-run experience when you're not in any orbit yet. */
export function Onboarding() {
  const router = useRouter();
  return (
    <div className="atmos-app flex flex-1 items-center justify-center px-4 py-10">
      <div className="animate-fade-up w-full max-w-[400px]">
        <div className="panel-card p-6 sm:p-7">
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <div className="brand-mark grid size-12 place-items-center rounded-2xl shadow-md">
              <Sparkles className="size-6 text-white" />
            </div>
            <div>
              <h1 className="text-[21px] font-semibold tracking-tight">Create your first orbit</h1>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                An orbit is your space — channels, members, and roles. Or join one with an invite.
              </p>
            </div>
          </div>
          <OrbitForm onDone={(id) => void router.visit(`/o/${id}`, { clientOnly: true })} />
        </div>
      </div>
    </div>
  );
}

/** The "+" in the orbit rail. */
export function CreateOrbitModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  return (
    <Modal open={open} onClose={onClose}>
      <div className="mb-4 flex items-center gap-2.5">
        <div className="brand-mark grid size-9 place-items-center rounded-xl">
          <Plus className="size-5 text-white" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Add an orbit</h2>
          <p className="text-[12.5px] text-muted-foreground">Create a new space or join with an invite.</p>
        </div>
      </div>
      <OrbitForm
        onDone={(id) => {
          onClose();
          void router.visit(`/o/${id}`, { clientOnly: true });
        }}
      />
    </Modal>
  );
}
