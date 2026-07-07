// The Better Auth instance for "en", backed by Rabbat.
//
// Auth is Google-only. The `bearer` plugin lets our non-cookie client (the WS
// functions client) authenticate with `Authorization: Bearer <token>`: the
// browser captures the session token and uses it for both the auth HTTP calls
// and the Rabbat functions WebSocket.
//
// Email+password is kept available ONLY when `devEmailAuth` is set (local e2e),
// since Google's OAuth round-trip can't run headless. Production is Google-only.

import { betterAuth } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";
import type { RabbatClient } from "rabbat/client-core";

import { defaultDisplayName, generateUniqueUsername } from "./username.ts";

import { rabbatAdapter } from "./auth-adapter.ts";
import { otpEmail } from "./email.ts";

export interface AuthOptions {
  /** Public base URL the browser reaches the auth API at (the app origin). */
  baseURL: string;
  /** Signing secret. */
  secret: string;
  /** Origins allowed to call the auth API (the app). */
  trustedOrigins: string[];
  /** Google OAuth credentials. */
  googleClientId: string;
  googleClientSecret: string;
  /** Enable email+password (dev/e2e only; the UI never exposes it). */
  devEmailAuth?: boolean;
  /** Resend API key — enables email-code (OTP) login. Unset = email disabled. */
  resendApiKey?: string;
  /** From address for login emails, e.g. `en <hello@en.winglee.dev>`. */
  emailFrom?: string;
  /** Dev: log OTPs to the console so local sign-in works without real email. */
  devLogOtp?: boolean;
}

/** Send a transactional email via Resend's HTTP API (no SDK dependency). */
async function sendEmail(
  opts: AuthOptions,
  msg: { to: string; subject: string; html: string; text: string },
): Promise<void> {
  if (!opts.resendApiKey) {
    if (opts.devLogOtp) console.log("[auth] RESEND_API_KEY unset — skipping email send");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${opts.resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: opts.emailFrom ?? "en <hello@en.winglee.dev>",
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body}`);
  }
}

export function createAuth(client: RabbatClient, opts: AuthOptions) {
  return betterAuth({
    appName: "en",
    database: rabbatAdapter(client),
    baseURL: opts.baseURL,
    basePath: "/api/auth",
    secret: opts.secret,
    trustedOrigins: opts.trustedOrigins,
    // Assign a unique @username (and a display name if missing) the moment a
    // user is created, so the data is correct by construction — no every-boot
    // full-table backfill scan (which a `--reject-unindexed` server rejects).
    // Best-effort: a failure leaves the user without a handle (fixable in the
    // profile editor) rather than blocking sign-up. The uniqueness check queries
    // `user where username = …`, which is index-served.
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; email?: string; name?: string }) => {
            try {
              const username = await generateUniqueUsername(
                client,
                user.email ?? user.name ?? user.id,
              );
              const patch: Record<string, string> = { username };
              if (!user.name || !user.name.trim()) patch.name = defaultDisplayName(user);
              await client.patch("user", user.id, patch);
            } catch (err) {
              console.error("[auth] username assignment failed:", (err as Error).message);
            }
          },
        },
      },
    },
    // Profile extras stored on the user row (see schema.ts).
    user: {
      additionalFields: {
        bio: { type: "string", required: false, input: true },
        accent: { type: "string", required: false, input: true },
        cover: { type: "string", required: false, input: true },
      },
    },
    socialProviders: {
      google: {
        clientId: opts.googleClientId,
        clientSecret: opts.googleClientSecret,
      },
    },
    emailAndPassword: { enabled: !!opts.devEmailAuth, autoSignIn: true, minPasswordLength: 6 },
    plugins: [
      // Bearer tokens — session token rides in the `set-auth-token` header.
      bearer(),
      // Email-code login: a 6-digit OTP, emailed via Resend. Signing in with a
      // code for a new email creates the account (then onboarding picks a name).
      emailOTP({
        otpLength: 6,
        expiresIn: 300, // 5 minutes
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (opts.devLogOtp) console.log(`[auth] OTP for ${email} (${type}): ${otp}`);
          // Newer better-auth adds a "change-email" type; treat it like verification.
          const otpType = type === "change-email" ? "email-verification" : type;
          const { subject, html, text } = otpEmail(otp, otpType);
          try {
            await sendEmail(opts, { to: email, subject, html, text });
          } catch (err) {
            // In dev the OTP is logged above, so don't block the flow on a send
            // failure (e.g. unverified domain). In prod, surface it to the user.
            console.error("[auth] login email failed:", (err as Error).message);
            if (!opts.devLogOtp) throw err;
          }
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
