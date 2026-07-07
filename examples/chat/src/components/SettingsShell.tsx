import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { MorphIndicatorGroup, MorphIndicatorItem } from "@/components/ui/morph-indicator";

export interface SettingsNavItem<K extends string> {
  key: K;
  label: string;
  icon: ReactNode;
}

/**
 * Full-screen settings chrome shared by the account and orbit settings pages.
 * Two purpose-built layouts rather than one responsive one:
 *   • desktop — a left nav rail (with the same liquid active-pill as the channel
 *     list) + a centered content column.
 *   • mobile — a native-feeling sticky top bar + a horizontal segmented tab row,
 *     content scrolling beneath.
 * Animates in as a page, and plays a brief exit before it navigates away (the
 * router would otherwise unmount it instantly). Escape / back close it.
 */
export function SettingsShell<K extends string>({
  title,
  nav,
  active,
  onSelect,
  onClose,
  footer,
  children,
}: {
  title: string;
  nav: SettingsNavItem<K>[];
  active: K;
  onSelect: (key: K) => void;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  // Close = navigate away immediately (no exit fade). Fading the overlay out
  // before navigating revealed the empty content frame behind it — a black flash
  // before the chat remounted. Navigating now hands straight to the chat instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return createPortal(
    <div
      data-anim="page"
      data-state="open"
      className="atmos-app fixed inset-0 z-50 flex flex-col sm:flex-row"
      style={{ paddingTop: "var(--sat)" }}
      role="dialog"
      aria-modal="true"
    >
      {/* ── Mobile: sticky top bar ─────────────────────────────────────────── */}
      <header className="glass-header sticky top-0 z-10 flex h-14 shrink-0 items-center gap-1 border-b border-border-strong px-1.5 sm:hidden">
        <button
          onClick={onClose}
          aria-label="Back"
          className="press grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground active:bg-accent"
        >
          <ChevronLeft className="size-[22px]" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-[15px] font-semibold tracking-tight">{title}</div>
        </div>
        <span className="size-9 shrink-0" aria-hidden />
      </header>

      {/* ── Mobile: segmented tab row ──────────────────────────────────────── */}
      <nav className="no-scrollbar flex shrink-0 gap-1.5 overflow-x-auto border-b border-border-strong px-3 py-2.5 sm:hidden">
        {nav.map((item) => {
          const on = item.key === active;
          return (
            <button
              key={item.key}
              onClick={() => onSelect(item.key)}
              aria-current={on}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-2 text-[13.5px] font-medium transition-colors active:scale-95 [&_svg]:size-4",
                on ? "bg-primary/15 text-primary" : "bg-elevated/50 text-muted-foreground",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* ── Desktop: left nav rail ─────────────────────────────────────────── */}
      <nav className="hidden shrink-0 flex-col bg-rail/60 px-3 py-4 backdrop-blur-xl sm:flex sm:w-[248px]">
        <button
          onClick={onClose}
          className="press group mb-3 flex items-center gap-2 rounded-lg px-2 py-2 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="size-4 shrink-0 transition-transform group-hover:-translate-x-0.5" />
          <span className="text-[13px] font-medium">Back</span>
        </button>

        <MorphIndicatorGroup activeId={active} className="flex flex-col gap-0.5" pillClassName="-left-1.5">
          {nav.map((item) => {
            const on = item.key === active;
            return (
              <MorphIndicatorItem key={item.key} id={item.key}>
                <button
                  onClick={() => onSelect(item.key)}
                  aria-current={on}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-medium transition-colors [&_svg]:size-4",
                    on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <span className={cn("transition-colors", on ? "text-primary" : "text-muted-foreground")}>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              </MorphIndicatorItem>
            );
          })}
        </MorphIndicatorGroup>

        {footer && <div className="mt-auto pt-2">{footer}</div>}
      </nav>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <button
          onClick={onClose}
          aria-label="Close settings"
          className="press absolute right-4 top-4 z-10 hidden size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:grid"
        >
          <X className="size-5" />
        </button>
        <div className="mx-auto w-full max-w-[680px] px-0 pb-[max(2.5rem,calc(var(--sab)+1.5rem))] sm:px-6 sm:pt-10">
          <div className="overflow-hidden border-border-strong bg-popover/40 sm:rounded-2xl sm:border">
            {children}
          </div>
        </div>

        {/* Mobile-only footer actions (e.g. sign out), below the content. */}
        {footer && <div className="px-4 pb-[max(2rem,var(--sab))] sm:hidden">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
