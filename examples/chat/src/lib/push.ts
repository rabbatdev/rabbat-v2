// Browser-side Web Push helpers: feature detection, permission, and translating
// a `PushSubscription` into the `{ endpoint, p256dh, auth }` the server stores.

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function permissionState(): NotificationPermission | "unsupported" {
  if (!pushSupported()) return "unsupported";
  return Notification.permission;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface PushKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function toKeys(sub: PushSubscription): PushKeys {
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  return { endpoint: j.endpoint ?? sub.endpoint, p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" };
}

/** This browser's existing subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Request permission + subscribe; returns the keys to store server-side. */
export async function subscribePush(vapidPublicKey: string): Promise<PushKeys> {
  if (!pushSupported()) throw new Error("Push notifications aren't supported on this browser.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications permission wasn't granted.");
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));
  return toKeys(sub);
}

/** Unsubscribe this browser; returns the endpoint that was removed (or null). */
export async function unsubscribePush(): Promise<string | null> {
  const sub = await currentSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  return endpoint;
}
