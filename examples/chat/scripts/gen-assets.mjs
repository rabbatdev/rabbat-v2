// Renders brand assets to PNG with puppeteer (run locally; outputs committed):
//   public/apple-touch-icon.png  (180×180, from the favicon mark)
//   public/og.png                (1200×630, default link preview)
//   public/og-invite.png         (1200×630, invite link preview)
import puppeteer from "puppeteer";
import { writeFileSync } from "node:fs";

const MARK = `
<svg viewBox="0 0 512 512" width="WW" height="HH">
  <rect width="512" height="512" rx="116" fill="#0b0b0c"/>
  <g fill="none" stroke="#fff" stroke-width="9">
    <circle cx="256" cy="256" r="166"/><circle cx="238" cy="278" r="100"/>
  </g>
  <g fill="#fff">
    <circle cx="388" cy="162" r="40"/><circle cx="150" cy="372" r="44"/>
    <circle cx="92" cy="250" r="22"/><circle cx="316" cy="342" r="20"/>
  </g>
</svg>`;

const FONT = `<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet"/>`;

function ogHtml({ eyebrow, title, subtitle }) {
  return `<!doctype html><html><head><meta charset="utf-8"/>${FONT}
  <style>*{margin:0;box-sizing:border-box}html,body{width:1200px;height:630px}</style></head>
  <body style="font-family:Geist,system-ui,sans-serif">
    <div style="width:1200px;height:630px;background:#0a0a0b;color:#fff;position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:center;padding:0 96px">
      <div style="position:absolute;top:-280px;right:-220px;width:760px;height:760px;border-radius:50%;background:radial-gradient(circle,rgba(168,85,247,0.45),transparent 62%);filter:blur(8px)"></div>
      <div style="position:absolute;bottom:-320px;left:-160px;width:680px;height:680px;border-radius:50%;background:radial-gradient(circle,rgba(217,70,239,0.20),transparent 64%)"></div>
      <div style="display:flex;align-items:center;gap:28px;position:relative">
        ${MARK.replace("WW", "104").replace("HH", "104")}
        <span style="font-size:88px;font-weight:700;letter-spacing:-3px">en</span>
      </div>
      <div style="position:relative;margin-top:48px">
        <div style="font-size:26px;font-weight:600;letter-spacing:6px;text-transform:uppercase;color:#a855f7">${eyebrow}</div>
        <div style="font-size:84px;font-weight:700;letter-spacing:-2px;line-height:1.05;margin-top:14px;max-width:1000px">${title}</div>
        <div style="font-size:34px;color:#9ca3af;margin-top:22px">${subtitle}</div>
      </div>
      <div style="position:absolute;bottom:56px;right:96px;font-size:26px;color:#6b7280;font-weight:500">en.winglee.dev</div>
    </div>
  </body></html>`;
}

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(html, w, h, out) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load", timeout: 15000 });
  await Promise.race([page.evaluate(() => document.fonts.ready), sleep(4000)]);
  await sleep(300);
  const buf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: w, height: h } });
  writeFileSync(out, buf);
  console.log("wrote", out);
}

// apple-touch-icon from the mark
await shot(
  `<!doctype html><html><body style="margin:0">${MARK.replace("WW", "180").replace("HH", "180")}</body></html>`,
  180,
  180,
  "public/apple-touch-icon.png",
);
await shot(ogHtml({ eyebrow: "chat in orbit", title: "Bring your people together", subtitle: "Real-time chat on a from-scratch reactive database." }), 1200, 630, "public/og.png");
await shot(ogHtml({ eyebrow: "you've been invited", title: "Join an orbit on en", subtitle: "Tap to accept your invite and start chatting." }), 1200, 630, "public/og-invite.png");

await browser.close();
