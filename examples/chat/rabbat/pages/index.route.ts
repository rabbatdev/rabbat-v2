import { defineRoute } from "@rabbat/react";

// Auth-gated app; client-rendered (the root layout gates on the Better Auth
// session, so there's nothing meaningful to server-render here).
export const Route = defineRoute({ path: "/", ssr: false });

export const route = Route
