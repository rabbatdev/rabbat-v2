import { defineRoute } from "@rabbat/react"

export const route = defineRoute({
  path: "/",
  meta: () => ({ title: "Rabbat Chat" }),
})
