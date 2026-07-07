// Better Auth browser client.
//
// The auth API is same-origin (Vite proxies /api/auth → the auth server). We use
// bearer tokens: on sign-in the server returns the session token in the
// `set-auth-token` response header, we stash it in localStorage, and send it
// back as `Authorization: Bearer <token>` — the same token we hand to the Rabbat
// functions WebSocket so every query/mutation runs as the signed-in user.

import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

const TOKEN_KEY = "rabbat-db.session-token";

export function getSessionToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
  plugins: [emailOTPClient()],
  fetchOptions: {
    auth: {
      type: "Bearer",
      token: () => getSessionToken(),
    },
    onSuccess: (ctx) => {
      const token = ctx.response.headers.get("set-auth-token");
      if (token) localStorage.setItem(TOKEN_KEY, token);
    },
  },
});

export function clearSessionToken() {
  localStorage.removeItem(TOKEN_KEY);
}
