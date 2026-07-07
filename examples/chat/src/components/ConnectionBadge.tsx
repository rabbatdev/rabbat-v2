import { useConnectionStatus } from "@rabbat/react"

/**
 * A plain UI component — it lives in `src/` (your code), not `rabbat/` (the
 * convention surface), and is imported by a page. It still uses rabbat's hooks.
 */
export function ConnectionBadge() {
  const status = useConnectionStatus()
  return <span className={`dot ${status}`} title={status} />
}
