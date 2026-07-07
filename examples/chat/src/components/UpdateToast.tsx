import { useState } from "react";
import { RefreshCw, Sparkles, X } from "lucide-react";

import { useVersionCheck } from "@/hooks/use-version-check";
import { useAnimatedOpen } from "./ui/use-animated-open";

/**
 * A small "a new version is available" prompt that slides up once a newer build
 * has been deployed (see useVersionCheck), offering a one-tap refresh. Rendered
 * once near the app root, above everything, independent of auth/route state.
 */
export function UpdateToast() {
  const stale = useVersionCheck();
  const [dismissed, setDismissed] = useState(false);
  const { render, state } = useAnimatedOpen(stale && !dismissed, 180);
  if (!render) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div
        data-anim="sheet"
        data-state={state}
        role="status"
        className="menu-surface pointer-events-auto flex items-center gap-3 rounded-2xl py-2 pl-2.5 pr-2"
      >
        <span className="brand-mark grid size-9 shrink-0 place-items-center rounded-[13px] text-white shadow-sm ring-1 ring-inset ring-white/10">
          <Sparkles className="size-[18px]" />
        </span>
        <div className="mr-1.5 leading-tight">
          <p className="text-[13.5px] font-semibold tracking-tight text-foreground">A new version is available</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">Refresh to get the latest.</p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="press group flex h-9 items-center gap-1.5 rounded-xl bg-primary pl-3 pr-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover"
        >
          <RefreshCw className="size-3.5 transition-transform duration-500 ease-out group-hover:-rotate-180" />
          Refresh
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
          className="press grid size-8 shrink-0 place-items-center rounded-xl text-muted-foreground/60 transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
