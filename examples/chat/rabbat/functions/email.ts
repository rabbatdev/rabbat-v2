// Email templates for "en". Plain HTML with inline styles (the only thing email
// clients reliably render) — a simple, light, on-brand login-code email.

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPE[c]);

/** A one-time login code email: { subject, html, text }. */
export function otpEmail(otp: string, type: "sign-in" | "email-verification" | "forget-password"): {
  subject: string;
  html: string;
  text: string;
} {
  const heading = type === "forget-password" ? "Reset your password" : type === "email-verification" ? "Verify your email" : "Your login code";
  const subject = type === "forget-password" ? "Reset your en password" : type === "email-verification" ? "Verify your en email" : "Your en login code";
  const lead =
    type === "forget-password"
      ? "Use this code to reset your password."
      : type === "email-verification"
        ? "Use this code to verify your email address."
        : "Enter this code in <b style=\"color:#3f3f46\">en</b> to finish signing in.";
  const code = esc(otp);

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f4f7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:440px;background:#ffffff;border:1px solid #ececf1;border-radius:16px;">
            <tr>
              <td style="padding:36px 36px 0;text-align:center;">
                <img src="https://en.winglee.dev/logo.png" alt="en" width="56" height="56" style="display:inline-block;width:56px;height:56px;border-radius:14px;" />
                <h1 style="margin:22px 0 6px;font-size:20px;line-height:1.3;color:#18181b;font-weight:650;">${esc(heading)}</h1>
                <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.55;">${lead}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 36px 4px;text-align:center;">
                <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#18181b;background:#f4f4f7;border-radius:12px;padding:18px 12px 18px 22px;">${code}</div>
                <p style="margin:14px 0 0;font-size:13px;color:#9ca3af;">This code expires in 5 minutes.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 36px 32px;text-align:center;">
                <div style="border-top:1px solid #f1f1f4;padding-top:18px;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">If you didn't request this, you can safely ignore this email.</p>
                  <p style="margin:8px 0 0;font-size:12px;color:#c4c4cf;">en · winglee.dev</p>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `${heading}\n\nYour code: ${otp}\nThis code expires in 5 minutes.\n\nIf you didn't request this, you can ignore this email.\n— en`;
  return { subject, html, text };
}
