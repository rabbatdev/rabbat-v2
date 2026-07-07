import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
}

/** Imperative confirm: `const confirm = useConfirm(); if (await confirm({...})) …`
 *  Renders a single shared dialog and resolves a promise on the user's choice. */
export function useConfirm() {
  const [state, setState] = useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null);
  const [busy, setBusy] = useState(false);

  const confirm = (opts: ConfirmOptions) =>
    new Promise<boolean>((resolve) => setState({ ...opts, resolve }));

  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
    setBusy(false);
  };

  const element = (
    <Modal open={!!state} onClose={() => !busy && close(false)} className="max-w-[400px]">
      {state && (
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{state.title}</h2>
          {state.description && (
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
              {state.description}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" className="h-9" onClick={() => close(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              className={cn(
                "h-9 gap-2",
                state.destructive
                  ? "bg-destructive text-white hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary-hover",
              )}
              onClick={() => {
                setBusy(true);
                close(true);
              }}
              disabled={busy}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {state.confirmLabel ?? "Confirm"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );

  return { confirm, confirmDialog: element };
}
