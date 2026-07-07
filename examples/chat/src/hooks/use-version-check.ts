import { useEffect, useState } from "react";

const POLL_MS = 60_000;

/**
 * Detect when a newer build has been deployed while this tab stays open.
 *
 * At build time vite bakes a `__BUILD_ID__` into the bundle and writes the same
 * id to `/version.json` (see vite.config.ts). We poll that file (cache-busted,
 * so a CDN/browser cache can't hide a new deploy) and flip to `true` once its id
 * no longer matches ours — the signal for {@link UpdateToast} to offer a refresh.
 *
 * Only polls while the tab is visible, plus immediately on focus/regaining
 * connectivity, so a backgrounded tab notices an update the moment it returns.
 * No-ops in dev (there's no build to go stale). Latches once true.
 */
export function useVersionCheck(): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    let alive = true;

    const check = async () => {
      if (!alive || document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { id?: string };
        if (alive && typeof data?.id === "string" && data.id !== __BUILD_ID__) setStale(true);
      } catch {
        // Offline, mid-deploy, or version.json missing — try again next tick.
      }
    };

    const iv = setInterval(check, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", check);
    void check();

    return () => {
      alive = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
    };
  }, []);

  return stale;
}
