import { readdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(__dirname, "..", "docs");

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function getDateDisplay(filename) {
  const match = filename.match(/tmj-(\d{4}-\d{2}-\d{2})\.html/);
  if (!match) return null;
  const parts = match[1].split("-").map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  const date = new Date(y, m - 1, d);
  const weekday = WEEKDAYS[date.getDay()];
  return { dateStr: match[1], display: `${y}年${m}月${d}日（週${weekday}）` };
}

function main() {
  const files = readdirSync(DOCS)
    .filter((f) => f.startsWith("tmj-") && f.endsWith(".html") && f !== "index.html")
    .sort()
    .reverse();

  const entries = files.map(getDateDisplay).filter(Boolean);
  const total = entries.length;

  const linksHtml = entries
    .slice(0, 60)
    .map(
      ({ dateStr, display }) =>
        `<li><a href="tmj-${dateStr}.html">📅 ${display}</a></li>`
    )
    .join("\n");

  const indexHtml = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>TMJ Disorder Daily · 顳顎關節障礙文獻日報</title>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; }
  .container { position: relative; z-index: 1; max-width: 640px; margin: 0 auto; padding: 80px 24px; }
  .logo { font-size: 48px; text-align: center; margin-bottom: 16px; }
  h1 { text-align: center; font-size: 24px; color: var(--text); margin-bottom: 8px; }
  .subtitle { text-align: center; color: var(--accent); font-size: 14px; margin-bottom: 48px; }
  .count { text-align: center; color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  ul { list-style: none; }
  li { margin-bottom: 8px; }
  a { color: var(--text); text-decoration: none; display: block; padding: 14px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; transition: all 0.2s; font-size: 15px; }
  a:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
  .clinic-section { margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--line); }
  .clinic-link { display: flex; align-items: center; gap: 10px; padding: 12px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; text-decoration: none; color: var(--text); font-size: 14px; margin-bottom: 8px; transition: all 0.2s; }
  .clinic-link:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
  .clinic-icon { font-size: 20px; }
  footer { margin-top: 56px; text-align: center; font-size: 12px; color: var(--muted); }
  footer a { display: inline; padding: 0; background: none; border: none; color: var(--muted); }
  footer a:hover { color: var(--accent); }
</style>
</head>
<body>
<div class="container">
  <div class="logo">🦷</div>
  <h1>TMJ Disorder Daily</h1>
  <p class="subtitle">顳顎關節障礙文獻日報 · 每日自動更新</p>
  <p class="count">共 ${total} 期日報</p>
  <ul>${linksHtml}</ul>

  <div class="clinic-section">
    <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
      <span class="clinic-icon">🏥</span> 李政洋身心診所首頁
    </a>
    <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
      <span class="clinic-icon">📬</span> 訂閱電子報
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="clinic-link" target="_blank" rel="noopener">
      <span class="clinic-icon">☕</span> Buy Me a Coffee
    </a>
  </div>

  <footer>
    <p>Powered by PubMed + NVIDIA AI · <a href="https://github.com/u8901006/TMJ-disorder">GitHub</a></p>
  </footer>
</div>
</body>
</html>`;

  writeFileSync(resolve(DOCS, "index.html"), indexHtml, "utf-8");
  console.error(`[INFO] Index page generated with ${total} reports`);
}

main();
