import { useState } from "react";
import { useMutation, useQuery } from "@rabbat/react";
import { Check, Copy, Link2, Loader2, Plus, Trash2 } from "lucide-react";

import { api } from "@/rabbat";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Select, type SelectOption } from "@/components/ui/select";

// Expiry choices (seconds; 0 = never) and max-use choices (0 = unlimited).
const EXPIRY_OPTIONS: SelectOption[] = [
  { value: "1800", label: "30 minutes" },
  { value: "3600", label: "1 hour" },
  { value: "21600", label: "6 hours" },
  { value: "43200", label: "12 hours" },
  { value: "86400", label: "1 day" },
  { value: "604800", label: "7 days" },
  { value: "0", label: "Never" },
];
const USES_OPTIONS: SelectOption[] = [
  { value: "0", label: "No limit" },
  { value: "1", label: "1 use" },
  { value: "5", label: "5 uses" },
  { value: "10", label: "10 uses" },
  { value: "25", label: "25 uses" },
  { value: "50", label: "50 uses" },
  { value: "100", label: "100 uses" },
];

function remaining(expiresAt: number | null): string {
  if (expiresAt == null) return "Never expires";
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "Expired";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `Expires in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `Expires in ${hrs}h`;
  return `Expires in ${Math.round(hrs / 24)}d`;
}

/** Create / list / revoke an orbit's invite links (shared by settings + the
 *  Invite People modal). Any member can manage invites. */
export function InviteManager({ orbitId }: { orbitId: string }) {
  const invites = useQuery(api.invites.list, { orbitId });
  const create = useMutation(api.invites.create);
  const revoke = useMutation(api.invites.revoke);
  const [expiresIn, setExpiresIn] = useState("604800");
  const [maxUses, setMaxUses] = useState("0");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function make() {
    setBusy(true);
    try {
      await create({ orbitId, expiresIn: Number(expiresIn), maxUses: Number(maxUses) });
    } finally {
      setBusy(false);
    }
  }
  function copy(code: string) {
    navigator.clipboard?.writeText(`${location.origin}/invite/${code}`);
    setCopied(code);
    setTimeout(() => setCopied((c) => (c === code ? null : c)), 1400);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-raised p-3.5">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">Expire after</label>
            <Select value={expiresIn} onChange={setExpiresIn} options={EXPIRY_OPTIONS} ariaLabel="Expire after" className="h-9 bg-background" />
          </div>
          <div>
            <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">Max uses</label>
            <Select value={maxUses} onChange={setMaxUses} options={USES_OPTIONS} ariaLabel="Max uses" className="h-9 bg-background" />
          </div>
        </div>
        <Button
          onClick={make}
          disabled={busy}
          className="mt-3 h-10 w-full gap-2 bg-primary text-primary-foreground hover:bg-primary-hover"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          Create invite link
        </Button>
      </div>

      <div className="space-y-2">
        {invites && invites.length === 0 && (
          <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-[13px] text-muted-foreground">
            No active invite links yet. Create one above to share.
          </p>
        )}
        {(invites ?? []).map((inv) => (
          <div key={inv.id} className="flex items-center gap-2.5 rounded-lg border border-border-strong bg-raised px-3 py-2.5">
            <Link2 className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[13px] text-foreground">/invite/{inv.id}</div>
              <div className="text-[11.5px] text-muted-foreground">
                {remaining(inv.expires_at)} · {inv.uses}
                {inv.max_uses != null ? `/${inv.max_uses}` : ""} {inv.uses === 1 && inv.max_uses == null ? "use" : "uses"}
              </div>
            </div>
            <button
              onClick={() => copy(inv.id)}
              aria-label="Copy invite link"
              className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {copied === inv.id ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </button>
            <button
              onClick={() => revoke({ id: inv.id })}
              aria-label="Revoke invite"
              className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/12 hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function InvitePeopleModal({
  orbitId,
  orbitName,
  onClose,
}: {
  orbitId: string;
  orbitName: string;
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} className="max-w-[460px]">
      <h2 className="text-[15px] font-semibold tracking-tight">Invite people</h2>
      <p className="mb-4 mt-0.5 text-[13px] text-muted-foreground">
        Share a link to bring people into {orbitName}.
      </p>
      <InviteManager orbitId={orbitId} />
      <div className="mt-4 flex justify-end">
        <Button variant="ghost" className="h-9" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
