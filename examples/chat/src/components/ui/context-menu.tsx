import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { useAnimatedOpen } from "./use-animated-open";

/** A single entry in a right-click menu. */
export type MenuItem =
  | {
      type?: "item";
      label: string;
      icon?: ReactNode;
      onSelect: () => void;
      destructive?: boolean;
      disabled?: boolean;
    }
  | { type: "separator" }
  | { type: "label"; label: string };

type OpenFn = (e: ReactMouseEvent, items: MenuItem[]) => void;
const ContextMenuCtx = createContext<OpenFn>(() => {});

/** Call inside any component to open a cursor-positioned menu on right-click:
 *  `onContextMenu={(e) => openMenu(e, [...])}`. */
export function useContextMenu(): OpenFn {
  return useContext(ContextMenuCtx);
}

interface State {
  x: number;
  y: number;
  items: MenuItem[];
  open: boolean;
}

/** App-level provider holding the single live menu. One portal, positioned at
 *  the cursor, dismissed on outside-click / Escape / scroll / blur. */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State | null>(null);

  const open = useCallback<OpenFn>((e, items) => {
    if (!items.length) return;
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items, open: true });
  }, []);

  const close = useCallback(() => setState((s) => (s ? { ...s, open: false } : null)), []);

  return (
    <ContextMenuCtx.Provider value={open}>
      {children}
      {state &&
        createPortal(
          <Menu state={state} onClose={close} onExited={() => setState(null)} />,
          document.body,
        )}
    </ContextMenuCtx.Provider>
  );
}

function Menu({ state, onClose, onExited }: { state: State; onClose: () => void; onExited: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  const { render, state: anim } = useAnimatedOpen(state.open, 130);

  // Once the exit animation finishes, let the provider drop the menu entirely.
  useEffect(() => {
    if (!render) onExited();
  }, [render, onExited]);

  // Clamp inside the viewport once we know the menu's measured size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    const x = Math.min(state.x, window.innerWidth - width - pad);
    const y = Math.min(state.y, window.innerHeight - height - pad);
    setPos({ x: Math.max(pad, x), y: Math.max(pad, y) });
  }, [state.x, state.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onScroll = () => onClose();
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    // Capture scroll anywhere so the menu doesn't float away from its anchor.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  if (!render) return null;
  return (
    <>
      <div data-anim="overlay" data-state={anim} className="fixed inset-0 z-[60]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={ref}
        role="menu"
        data-anim="menu"
        data-state={anim}
        className={cn(
          "menu-surface fixed z-[61] min-w-[188px] p-1.5",
          anim === "closed" && "pointer-events-none",
        )}
        style={{ left: pos.x, top: pos.y, transformOrigin: "top left" }}
      >
        {state.items.map((item, i) => {
          if (item.type === "separator") return <div key={i} className="menu-sep" />;
          if (item.type === "label")
            return (
              <div
                key={i}
                className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint"
              >
                {item.label}
              </div>
            );
          return (
            <button
              key={i}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              className={cn(
                "flex w-full items-center gap-2.5 px-2.5 py-[7px] text-left text-[13px] disabled:pointer-events-none disabled:opacity-40",
                item.destructive
                  ? "rounded-[9px] text-destructive transition-colors hover:bg-destructive/15"
                  : "menu-item text-foreground",
              )}
            >
              {item.icon && (
                <span className={cn("grid size-4 shrink-0 place-items-center [&_svg]:size-4", !item.destructive && "text-muted-foreground")}>
                  {item.icon}
                </span>
              )}
              <span className="flex-1 truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
