import { useEffect, useRef, useState } from "react";

/**
 * Keeps an overlay/portal mounted through its *exit* animation. React unmounts
 * instantly on `open=false`, which kills any closing transition — this defers
 * the unmount by `exitMs` so a CSS exit keyframe can play first.
 *
 * Returns `{ render, state }`:
 *  • `render` — whether to render the element at all (true while open or exiting)
 *  • `state`  — `"open"` | `"closed"`, mirror to `data-state` so CSS can pick the
 *               enter vs. exit keyframe.
 *
 * Pair with the `[data-state]` animation rules in styles.css.
 */
export function useAnimatedOpen(open: boolean, exitMs = 160): {
  render: boolean;
  state: "open" | "closed";
} {
  const [render, setRender] = useState(open);
  const [state, setState] = useState<"open" | "closed">(open ? "open" : "closed");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    if (open) {
      setRender(true);
      // Mount in the "closed" pose for one frame, then flip to "open" so the
      // enter keyframe always has a from-state to animate out of.
      const raf = requestAnimationFrame(() => setState("open"));
      return () => cancelAnimationFrame(raf);
    }
    // Closing: play the exit keyframe, then unmount.
    setState("closed");
    timer.current = setTimeout(() => setRender(false), exitMs);
    return () => clearTimeout(timer.current);
  }, [open, exitMs]);

  return { render, state };
}
