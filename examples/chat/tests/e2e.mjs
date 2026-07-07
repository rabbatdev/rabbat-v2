// Real-browser e2e for "en" on the Rabbat framework. Drives the UI for the
// auth-gate → onboarding → orbit/channel flow, then verifies the reactive
// message path: a message sent through the function API appears LIVE in the
// browser feed and survives a reload.
//
// Single port (the framework host): pages + /api/auth + the /functions
// WebSocket all on :3650. Run the app with `rabbat dev` or `rabbat start`
// (email auth is on in dev, so this signs in without Google).
//
// Why the message is sent via the API, not typed: the composer is the ori
// rich-text editor (a contenteditable whose value lives in an editor doc model),
// which can't be driven reliably headlessly. Sending through the same mutation
// the UI calls — and asserting it shows up live — exercises the reactive path
// that actually matters.
import puppeteer from "puppeteer";
import { FunctionsClient } from "rabbat/client";
import { api } from "../functions/_generated/api.ts";

const APP = process.env.APP_URL ?? "http://localhost:3650";
const FNS = APP.replace(/^http/, "ws") + "/functions";
let failures = 0;
const check = (c, label) => {
  console.log(`${c ? "✓" : "✗"} ${label}`);
  if (!c) failures++;
};

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"], protocolTimeout: 90000 });
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const wait = async (fn, ms = 12000, ...a) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try {
        if (await p.evaluate(fn, ...a)) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  };

  // 1) Signed out → the auth gate.
  await p.goto(APP, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 1000));
  check(/Continue with Google/.test(await p.evaluate(() => document.body.innerText)), "app is gated behind sign-in");

  // 2) Sign up out-of-band (origin header → trusted) and adopt the session.
  const email = `e2e_${Date.now()}@e2e.dev`;
  const res = await fetch(`${APP}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify({ email, password: "hunter2pw", name: "E2E Tester" }),
  });
  check(res.status === 200, "email sign-up succeeds");
  const token = res.headers.get("set-auth-token");
  const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), url: APP };
  });
  if (cookies.length) await p.setCookie(...cookies);

  await p.reload({ waitUntil: "load" });
  check(await wait(() => /Create your first orbit/.test(document.body.innerText)), "first-run onboarding shown");

  // 3) Create an orbit → become owner with starter channels, auto-opening one.
  await p.type('input[placeholder="Acme HQ"]', "E2E Orbit");
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Create orbit")?.click());
  check(await wait(() => [...document.querySelectorAll("aside a")].some((a) => /general/.test(a.textContent))), "orbit created with starter channels");
  check(await wait(() => /\/c\/chan_/.test(location.href) && !!document.querySelector(".ori-ce")), "a channel auto-opens with the composer");

  // 4) Owner creates a channel via the orbit header menu (the header button
  //    carries the orbit name).
  await p.evaluate(() =>
    [...document.querySelectorAll('aside [role="button"], aside button')].find((b) => /E2E Orbit/.test(b.textContent))?.click(),
  );
  await wait(() => /New channel/.test(document.body.innerText), 4000);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "New channel")?.click());
  check(await wait(() => /Create channel/.test(document.body.innerText), 4000), "owner can open create-channel");
  await p.type('input[placeholder="new-channel"]', "from-e2e");
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Create")?.click());
  check(await wait(() => [...document.querySelectorAll("aside a")].some((a) => /from-e2e/.test(a.textContent))), "channel created (permission granted)");

  // 5) The reactive heart: send a message through the function API and watch it
  //    arrive live in the open feed, then persist across a reload.
  const channelId = (await p.evaluate(() => location.href)).match(/\/c\/(chan_[a-z0-9]+)/)?.[1];
  const db = new FunctionsClient({ url: FNS });
  db.connect();
  db.setAuth(token);
  await new Promise((r) => setTimeout(r, 800));
  const msg = `hello rabbat ${Date.now() % 100000}`;
  let sent = true;
  try {
    await db.mutation(api.messages.send, { channelId, body: msg });
  } catch {
    sent = false;
  }
  check(sent, "message sent via the function API");
  check(await wait((m) => document.body.innerText.includes(m), 8000, msg), "message appears live in the feed (reactive)");

  await p.reload({ waitUntil: "load" });
  check(await wait((m) => document.body.innerText.includes(m), 12000, msg), "message persists across reload");
} catch (err) {
  console.error("e2e failure:", err.message);
  failures++;
} finally {
  await browser.close();
}
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
