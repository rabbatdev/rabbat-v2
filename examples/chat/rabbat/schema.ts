import { defineSchema, defineTable, s } from "@rabbat/schema"

/**
 * The chat schema — the single source of truth. `messages` carries a composite
 * index `(channel_id, created_at)` so a channel's feed paginates by an index
 * seek (no scan + sort), and reactive writes route by `channel_id`.
 */
export const schema = defineSchema({
  channels: defineTable({
    id: s.text().primaryKey(),
    name: s.text().unique(),
    created_at: s.int().index(),
  }),
  messages: defineTable(
    {
      id: s.text().primaryKey(),
      channel_id: s.text(),
      author: s.text(),
      body: s.text(),
      created_at: s.int(),
    },
    { indexes: [{ name: "by_channel", columns: ["channel_id", "created_at"] }] },
  ),
})
