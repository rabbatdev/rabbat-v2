import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { useAnimatedOpen } from "./use-animated-open";

/** A small, dependency-free modal: dimmed overlay, centered card, Escape + click
 *  outside to close, scroll lock. Animates in (lift + scale) and — because it
 *  stays mounted through the exit keyframe — out again when `open` flips false. */
export function Modal({
  open,
  onClose,
  children,
  className,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  const { render, state } = useAnimatedOpen(open, 160);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!render) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
    >
      <div
        data-anim="overlay"
        data-state={state}
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        data-anim="dialog"
        data-state={state}
        className={cn(
          "surface-float relative z-10 max-h-[90dvh] w-full max-w-[420px] overflow-y-auto rounded-2xl border border-border-strong bg-popover p-5",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
