// rabbat/client-core → @rabbat/db. The original's `RabbatClient` (an ad-hoc
// server-side DB client) is rabbat-v2's `RabbatDb`.
export * from "@rabbat/db"
export type { RabbatDb as RabbatClient } from "@rabbat/db"
