// Remembers where you were so the app reopens to it. On first load (or when you
// switch orbits) we restore your last orbit and, within each orbit, the last
// channel you had open — keyed per-orbit so every orbit reopens to its own spot.
//
// Stored in localStorage (per-browser, survives reloads). All reads are
// defensive: a stored id is only a hint — callers validate it still exists
// before navigating, so a deleted orbit/channel just falls back gracefully.

const ORBIT_KEY = "en:lastOrbit";
const channelKey = (orbitId: string) => `en:lastChannel:${orbitId}`;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / quota — remembering is best-effort, never fatal.
  }
}

/** Record the orbit (and optionally the channel) you're currently viewing. */
export function rememberLocation(orbitId: string, channelId?: string) {
  if (orbitId) safeSet(ORBIT_KEY, orbitId);
  if (orbitId && channelId) safeSet(channelKey(orbitId), channelId);
}

/** The last orbit you had open, if any. */
export function getLastOrbit(): string | null {
  return safeGet(ORBIT_KEY);
}

/** The last channel you had open in `orbitId`, if any. */
export function getLastChannel(orbitId: string): string | null {
  return safeGet(channelKey(orbitId));
}
