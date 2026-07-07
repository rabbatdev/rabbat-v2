import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAnimatedOpen } from "./use-animated-open";

export interface SelectOption {
  value: string;
  label: string;
}

/** A styled dropdown that replaces the native <select>: a trigger button plus a
 *  portaled, keyboard-navigable option list anchored to it. */
export function Select({
  value,
  onChange,
  options,
  className,
  placeholder = "Select…",
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const selected = options.find((o) => o.value === value);

  function toggle() {
    if (disabled) return;
    if (!open && triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-md border border-input bg-raised px-3 text-[13.5px] text-foreground transition-colors hover:border-border-strong focus-visible:border-primary/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          open && "border-primary/60",
          className,
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate text-left", !selected && "text-muted-foreground")}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {rect &&
        createPortal(
          <SelectMenu
            open={open}
            rect={rect}
            options={options}
            value={value}
            onClose={() => setOpen(false)}
            onExited={() => setRect(null)}
            onSelect={(v) => {
              onChange(v);
              setOpen(false);
            }}
          />,
          document.body,
        )}
    </>
  );
}

function SelectMenu({
  open,
  rect,
  options,
  value,
  onClose,
  onExited,
  onSelect,
}: {
  open: boolean;
  rect: DOMRect;
  options: SelectOption[];
  value: string;
  onClose: () => void;
  onExited: () => void;
  onSelect: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { render, state: anim } = useAnimatedOpen(open, 130);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const [style, setStyle] = useState<CSSProperties>({
    left: rect.left,
    top: rect.bottom + 6,
    width: rect.width,
    transformOrigin: "top center",
  });

  // Flip above the trigger when there isn't room below.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const pad = 8;
    const below = window.innerHeight - rect.bottom - pad;
    const openUp = below < h && rect.top - pad > below;
    setStyle({
      left: rect.left,
      top: openUp ? Math.max(pad, rect.top - h - 6) : rect.bottom + 6,
      width: rect.width,
      transformOrigin: openUp ? "bottom center" : "top center",
    });
  }, [rect]);

  useEffect(() => {
    if (!render) onExited();
  }, [render, onExited]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(options.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const o = options[active];
        if (o) onSelect(o.value);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [open, active, options, onSelect, onClose]);

  if (!render) return null;
  return (
    <>
      <div className="fixed inset-0 z-[70]" onClick={onClose} />
      <div
        ref={ref}
        role="listbox"
        data-anim="menu"
        data-state={anim}
        className={cn(
          "menu-surface fixed z-[71] max-h-[280px] overflow-auto p-1.5",
          anim === "closed" && "pointer-events-none",
        )}
        style={style}
      >
        {options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={o.value === value}
            onMouseEnter={() => setActive(i)}
            onClick={() => onSelect(o.value)}
            className={cn(
              "flex w-full items-center gap-2 rounded-[9px] px-2.5 py-[7px] text-left text-[13px] transition-colors",
              i === active ? "bg-white/[0.06] text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.value === value && <Check className="size-4 shrink-0 text-primary" />}
          </button>
        ))}
      </div>
    </>
  );
}
