import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "@/lib/utils";

type Box = { top: number; height: number; visible: boolean };

type MorphCtx = {
  register: (id: string, el: HTMLElement | null) => void;
};

const MorphIndicatorContext = createContext<MorphCtx | null>(null);

/** Spring-animated top — snappy with a touch of overshoot. */
const TOP_SPRING = { stiff: 520, damp: 24 };
/** Spring-animated height — softer so the pill stretches while travelling. */
const HEIGHT_SPRING = { stiff: 280, damp: 20 };

function stepSpring(
  pos: number,
  vel: number,
  goal: number,
  dt: number,
  { stiff, damp }: { stiff: number; damp: number },
) {
  const acc = stiff * (goal - pos) - damp * vel;
  const nextVel = vel + acc * dt;
  return { pos: pos + nextVel * dt, vel: nextVel };
}

/** Liquid morph — height lags behind top so the pill stretches mid-flight. */
function useLiquidMorph(target: Box) {
  const [render, setRender] = useState(target);
  const pos = useRef({ top: target.top, height: target.height });
  const vel = useRef({ top: 0, height: 0 });
  const raf = useRef(0);
  const primed = useRef(false);

  useLayoutEffect(() => {
    if (!target.visible) {
      primed.current = false;
      setRender((r) => (r.visible ? { ...r, visible: false } : r));
      return;
    }

    if (!primed.current) {
      primed.current = true;
      pos.current = { top: target.top, height: target.height };
      vel.current = { top: 0, height: 0 };
      setRender(target);
      return;
    }

    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.028);
      last = now;

      const top = stepSpring(pos.current.top, vel.current.top, target.top, dt, TOP_SPRING);
      const height = stepSpring(pos.current.height, vel.current.height, target.height, dt, HEIGHT_SPRING);
      pos.current = { top: top.pos, height: height.pos };
      vel.current = { top: top.vel, height: height.vel };

      const settled =
        Math.abs(target.top - top.pos) < 0.45 &&
        Math.abs(target.height - height.pos) < 0.45 &&
        Math.abs(top.vel) < 0.45 &&
        Math.abs(height.vel) < 0.45;

      if (settled) {
        pos.current = { top: target.top, height: target.height };
        vel.current = { top: 0, height: 0 };
        setRender(target);
        return;
      }

      setRender({ top: top.pos, height: height.pos, visible: true });
      raf.current = requestAnimationFrame(tick);
    };

    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target.top, target.height, target.visible]);

  return render;
}

/** A single pill that liquid-morphs between registered items. */
export function MorphIndicatorGroup({
  activeId,
  className,
  pillClassName,
  scrollRef,
  children,
}: {
  activeId?: string | null;
  className?: string;
  pillClassName?: string;
  scrollRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(new Map<string, HTMLElement>());
  const [target, setTarget] = useState<Box>({ top: 0, height: 0, visible: false });
  const box = useLiquidMorph(target);

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) itemsRef.current.set(id, el);
    else itemsRef.current.delete(id);
  }, []);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const active = activeId ? itemsRef.current.get(activeId) : undefined;
    if (!container || !active) {
      setTarget((t) => (t.visible ? { ...t, visible: false } : t));
      return;
    }
    const cRect = container.getBoundingClientRect();
    const aRect = active.getBoundingClientRect();
    setTarget({
      top: aRect.top - cRect.top + container.scrollTop,
      height: aRect.height,
      visible: true,
    });
  }, [activeId]);

  useLayoutEffect(() => {
    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [measure, children]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    if (activeId) {
      const active = itemsRef.current.get(activeId);
      if (active) ro.observe(active);
    }
    return () => ro.disconnect();
  }, [measure, activeId]);

  useLayoutEffect(() => {
    const scrollEl = scrollRef?.current ?? containerRef.current;
    if (!scrollEl) return;
    scrollEl.addEventListener("scroll", measure, { passive: true });
    return () => scrollEl.removeEventListener("scroll", measure);
  }, [measure, scrollRef]);

  return (
    <MorphIndicatorContext.Provider value={{ register }}>
      <div ref={containerRef} className={cn("relative", className)}>
        {box.visible && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute left-0 w-[3px] rounded-r-full bg-primary will-change-[top,height]",
              pillClassName,
            )}
            style={{ top: box.top, height: Math.max(box.height, 4) }}
          />
        )}
        {children}
      </div>
    </MorphIndicatorContext.Provider>
  );
}

/** Registers an item with the nearest {@link MorphIndicatorGroup}. */
export function MorphIndicatorItem({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const ctx = useContext(MorphIndicatorContext);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      ctx?.register(id, el);
    },
    [ctx, id],
  );

  if (!ctx) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
