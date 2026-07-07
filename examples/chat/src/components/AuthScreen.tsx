import { useState, type FormEvent } from "react";
import { ArrowLeft, Loader2, Mail } from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { errorMessage } from "@/lib/util";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="size-[18px]" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

export function AuthScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Email-code (OTP) login: enter email → receive a 6-digit code → sign in.
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({ email: addr, type: "sign-in" });
      if (res.error) throw new Error(res.error.message || "Couldn't send the code. Try again.");
      setCode("");
      setStage("code");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    const otp = code.trim();
    if (otp.length < 6 || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await authClient.signIn.emailOtp({ email: email.trim(), otp });
      if (res.error) throw new Error(res.error.message || "That code is invalid or expired.");
      window.location.assign(window.location.pathname + window.location.search || "/");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function continueWithGoogle() {
    setError(null);
    setBusy(true);
    try {
      // Return to wherever they started (e.g. an /invite/<code> link) instead
      // of always landing on the home page.
      const dest = window.location.pathname + window.location.search || "/";
      await authClient.signIn.social({
        provider: "google",
        callbackURL: dest,
      });
    } catch (e) {
      setError(errorMessage(e) || "Could not start Google sign-in.");
      setBusy(false);
    }
  }

  // Dev-only: sign in as a fixed test user without Google. Gated by
  // `import.meta.env.DEV`, so this branch is stripped from prod builds (and the
  // server's email auth is off in prod regardless).
  async function devSignIn() {
    setError(null);
    setBusy(true);
    const email = "dev@en.test";
    const password = "dev-password";
    try {
      const res = await authClient.signIn.email({ email, password });
      if (res.error) {
        const up = await authClient.signUp.email({ email, password, name: "Dev User" });
        if (up.error) throw new Error(up.error.message || "Dev sign-in failed.");
      }
      window.location.assign(window.location.pathname + window.location.search || "/");
    } catch (e) {
      setError(errorMessage(e) || "Dev sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <div className="atmos-app relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="animate-fade-up relative z-10 w-full max-w-[380px]">
        <div className="panel-card p-8 text-center">
          <div className="mb-7 flex flex-col items-center gap-4">
            <img src="/logo.png" alt="en" className="size-14 rounded-2xl object-cover shadow-md" />
            <div>
              <h1 className="text-[24px] font-semibold tracking-tight">Welcome to en</h1>
              <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                Spin up an orbit and bring your people together.
              </p>
            </div>
          </div>

          <Button
            onClick={continueWithGoogle}
            disabled={busy}
            className="surface-raised h-11 w-full gap-2.5 rounded-xl bg-elevated text-[14px] font-medium text-foreground hover:bg-elevated/80"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <GoogleMark />}
            Continue with Google
          </Button>

          <div className="my-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[11px] font-medium uppercase tracking-wider text-faint">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          {stage === "email" ? (
            <form onSubmit={sendCode} className="space-y-2.5 text-left">
              <Input
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                // 16px on mobile so iOS doesn't zoom on focus; 14px on desktop.
                className="h-11 bg-raised text-center text-[16px] sm:text-[14px]"
              />
              <Button
                type="submit"
                disabled={busy || !email.trim()}
                className="h-11 w-full gap-2 rounded-xl bg-primary text-[14px] font-medium text-primary-foreground hover:bg-primary-hover"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
                Email me a code
              </Button>
            </form>
          ) : (
            <form onSubmit={verifyCode} className="space-y-2.5 text-left">
              <p className="text-center text-[12.5px] text-muted-foreground">
                Enter the 6-digit code sent to <span className="font-medium text-foreground">{email}</span>
              </p>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                className="h-12 bg-raised text-center text-[22px] font-semibold tracking-[0.4em]"
              />
              <Button
                type="submit"
                disabled={busy || code.trim().length < 6}
                className="h-11 w-full gap-2 rounded-xl bg-primary text-[14px] font-medium text-primary-foreground hover:bg-primary-hover"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                Sign in
              </Button>
              <button
                type="button"
                onClick={() => {
                  setStage("email");
                  setCode("");
                  setError(null);
                }}
                className="flex w-full items-center justify-center gap-1.5 pt-0.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                Use a different email
              </button>
            </form>
          )}

          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={devSignIn}
              disabled={busy}
              className="mt-3 w-full rounded-xl border border-dashed border-border-strong bg-transparent py-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-elevated/60 hover:text-foreground disabled:opacity-50"
            >
              Dev sign-in (test user)
            </button>
          )}

          {error && <p className="mt-3 text-[12.5px] text-destructive">{error}</p>}

          <p className="mt-7 text-[12px] leading-relaxed text-faint">
            By continuing you agree this is a demo running on Rabbat. We only read your
            name, email and avatar from Google.
          </p>
        </div>
      </div>
    </div>
  );
}
