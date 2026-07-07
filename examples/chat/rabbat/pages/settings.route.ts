import { defineRoute } from "@rabbat/react";

// Client-rendered user settings (gated behind the signed-in session).
export const Route = defineRoute({ path: "/settings", ssr: false });

export const route = Route
