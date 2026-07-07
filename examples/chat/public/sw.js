/* en — service worker. Its only job is Web Push: show a notification when the
   server pushes one (even with no tab open), and focus/open the app at the
   linked message when the notification is clicked. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "en", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "en";
  const options = {
    body: data.body || "",
    icon: "/logo.png",
    badge: "/logo.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || "/" },
  };
  // Diagnostic: if this logs but no banner appears, the OS/browser is suppressing
  // the display (Focus/Do Not Disturb, or notifications off for this browser).
  console.log("[sw] push received:", title, options.body);
  event.waitUntil(
    self.registration
      .showNotification(title, options)
      .catch((err) => console.error("[sw] showNotification failed:", err)),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              /* cross-origin or unsupported — ignore */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});
