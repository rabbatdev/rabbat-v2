import "@/styles.css";

import { useEffect, type ReactNode } from "react";
import { useKeepAlive, useMutation, usePage, useQuery, useRabbat } from "@rabbat/react";
import { Loader2 } from "lucide-react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ContextMenuProvider } from "@/components/ui/context-menu";
import { api, type Orbit } from "@/rabbat";
import { IdentityContext } from "@/context/identity";
import { MobileNavProvider } from "@/context/mobile-nav";
import { LightboxProvider } from "@/context/lightbox";
import { authClient, clearSessionToken, getSessionToken } from "@/lib/auth-client";
import { AuthScreen } from "@/components/AuthScreen";
import { UpdateToast } from "@/components/UpdateToast";
import { OrbitRail } from "@/components/OrbitRail";

function Splash() {
  return (
    <div className="atmos-app flex min-h-screen flex-col items-center justify-center gap-4">
      <img src="/logo.png" alt="en" className="splash-mark size-14 rounded-2xl object-cover shadow-lg" />
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Presence heartbeat — keeps online status fresh while the tab is visible. */
function Heartbeat() {
  const beat = useMutation(api.presence.heartbeat);
  useEffect(() => {
    const fire = () => {
      if (document.visibilityState === "visible") void beat({}).catch(() => {});
    };
    fire();
    const iv = setInterval(fire, 20_000);
    document.addEventListener("visibilitychange", fire);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", fire);
    };
  }, [beat]);
  return null;
}

/** Keep every orbit's channel + category lists live in the background, so
 *  switching orbits always shows a fresh sidebar instantly. */
function BackgroundQueries() {
  const orbits = (useQuery(api.orbits.listMine, {}) as Orbit[] | undefined) ?? [];
  useKeepAlive(
    orbits.flatMap((o) => [
      { query: api.channels.list, args: { orbitId: o.id } },
      { query: api.categories.list, args: { orbitId: o.id } },
    ]),
  );
  return null;
}

/** Drive the shell height from the real viewport (iOS standalone safe-area). */
function useAppHeight() {
  useEffect(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top);visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    let lastWidth = window.innerWidth;
    const setAppHeight = () => {
      const topInset = probe.getBoundingClientRect().height;
      const full = Math.min(window.innerHeight + topInset, window.screen.height);
      const rotated = window.innerWidth !== lastWidth;
      lastWidth = window.innerWidth;
      const cur = parseFloat(document.documentElement.style.getPropertyValue("--app-h")) || 0;
      if (rotated || full > cur) document.documentElement.style.setProperty("--app-h", `${full}px`);
    };
    setAppHeight();
    window.addEventListener("resize", setAppHeight);
    window.visualViewport?.addEventListener("resize", setAppHeight);
    return () => {
      window.removeEventListener("resize", setAppHeight);
      window.visualViewport?.removeEventListener("resize", setAppHeight);
      probe.remove();
    };
  }, []);
}

function useServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
}

export default function Layout({ children }: { children: ReactNode }) {
  useAppHeight();
  useServiceWorker();
  const { data: session, isPending } = authClient.useSession();
  const db = useRabbat();
  const isInvite = usePage().url.startsWith("/invite/");

  // Authenticate the /functions WebSocket once signed in (the bearer token, set
  // by Better Auth's set-auth-token header). The connection re-resolves identity.
  useEffect(() => {
    db.setAuth(session?.user ? getSessionToken() : null);
  }, [db, session?.user?.id]);

  if (isPending) return <Splash />;
  if (!session?.user) return <AuthScreen />;

  const u = session.user;
  const signOut = async () => {
    await authClient.signOut();
    clearSessionToken();
    await db.clearCache();
    window.location.href = "/";
  };

  return (
    <IdentityContext.Provider
      value={{ userId: u.id, displayName: u.name || u.email, email: u.email, image: u.image ?? null, signOut }}
    >
      <Heartbeat />
      <BackgroundQueries />
      <TooltipProvider delayDuration={250}>
        <ContextMenuProvider>
          <MobileNavProvider>
            <LightboxProvider>
              <div
                className="flex overflow-hidden bg-[var(--background)] text-foreground md:bg-[var(--frame)]"
                // Fall back to the dynamic viewport until useAppHeight() sets --app-h
                // (its effect runs after first paint) — otherwise the shell briefly
                // collapses to content height and black flashes below it.
                style={{ height: "var(--app-h, 100dvh)", paddingTop: "var(--sat)" }}
              >
                {!isInvite && <OrbitRail />}
                <main className="flex min-w-0 flex-1 md:mt-2 md:overflow-hidden md:rounded-tl-2xl md:border-t md:border-l md:border-border-strong">
                  {children}
                </main>
              </div>
              <UpdateToast />
            </LightboxProvider>
          </MobileNavProvider>
        </ContextMenuProvider>
      </TooltipProvider>
    </IdentityContext.Provider>
  );
}
