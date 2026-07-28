import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DOCS = resolve(ROOT, "docs");

const API_BASE = "https://integrate.api.nvidia.com/v1";
const MODELS = ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-nano-30b-a3b"];
const MAX_TOKENS = 16384;
const TIMEOUT_MS = 480_000;
const MAX_RETRIES = 3;

const SYSTEM_PROMPT = `你是顳顎關節障礙症（TMJ Disorder / TMD）研究的專業分析師。你的任務是：
1. 從提供的文獻清單中，分析出最新的臨床洞察與研究趨勢
2. 每篇文獻必須分類到以下TMJ研究主題中
3. 評估臨床實用性（高/中/低）
4. 提供適合醫師與研究人員閱讀的摘要

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 每篇文獻包含：中文標題、英文標題、期刊名、一句話精要摘要、PICO 分析、臨床實用性、相關標籤
- 最後提供本日 TOP 5-8 篇最重要的精選文獻
- 嚴格輸出 JSON，不要用 markdown code block 包裹`;

const TMJ_TAGS = [
  "疼痛機制與神經科學",
  "心理因素",
  "行為與心理治療",
  "磨牙與睡眠",
  "頭痛與偏頭痛",
  "結構性TMJ疾病",
  "牙科與物理治療",
  "藥物與注射治療",
  "手術治療",
  "影像診斷",
  "流行病學",
  "診斷標準DC/TMD",
  "系統性回顧",
  "隨機對照試驗",
  "生活品質",
];

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loadPapers(inputPath) {
  const raw = readFileSync(inputPath, "utf-8");
  return JSON.parse(raw);
}

function stripMarkdownCodeBlock(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) {
      cleaned = cleaned.slice(firstNewline + 1);
    } else {
      cleaned = cleaned.slice(3);
    }
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}

function robustJsonParse(text) {
  const cleaned = stripMarkdownCodeBlock(text);
  try {
    return JSON.parse(cleaned);
  } catch {}

  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      return JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
    } catch {}
  }

  let fixed = cleaned;
  for (let i = 0; i < 3; i++) {
    try {
      return JSON.parse(fixed);
    } catch (e) {
      const posMatch = e.message.match(/position\s+(\d+)/);
      if (!posMatch) break;
      const pos = parseInt(posMatch[1], 10);
      const char = fixed[pos];
      if (char === "'" || char === "「" || char === "」") {
        fixed = fixed.slice(0, pos) + '"' + fixed.slice(pos + 1);
      } else if (char === "\n" || char === "\r") {
        fixed = fixed.slice(0, pos) + " " + fixed.slice(pos + 1);
      } else {
        break;
      }
    }
  }

  return null;
}

async function callNvidiaApi(apiKey, payload) {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (resp.status === 429) {
    throw Object.assign(new Error("Rate limited"), { status: 429 });
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function analyzePapers(apiKey, papersData) {
  const dateStr = papersData.date;
  const paperCount = papersData.count;
  const papersText = JSON.stringify(papersData.papers ?? [], null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 擷取的最新 TMJ 顳顎關節障礙症文獻（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block 包裹）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句總結今日TMJ研究動態與重點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名稱",
      "summary": "一句話精要摘要（繁體中文，突出核心發現與臨床洞察）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "說明實用性的一句話",
      "tags": ["標籤1", "標籤2"],
      "url": "連結",
      "emoji": "合適的emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話摘要",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "疼痛機制": 3,
    "心理因素": 2
  }
}

原始文獻資料：
${papersText}

請挑出最重要的 TOP 5-8 篇文獻放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：${TMJ_TAGS.join("、")}
注意：嚴格輸出 JSON，不要用 markdown code block 包裹。`;

  for (const model of MODELS) {
    const payload = {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 1.0,
      top_p: 0.95,
      max_tokens: MAX_TOKENS,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt}/${MAX_RETRIES})...`);
        const data = await callNvidiaApi(apiKey, payload);
        const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
        if (!text) throw new Error("Empty response from API");

        const result = robustJsonParse(text);
        if (!result) {
          console.error(`[WARN] JSON parse failed on attempt ${attempt}`);
          if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        console.error(
          `[INFO] Analysis complete: ${(result.top_picks ?? []).length} top picks, ${(result.all_papers ?? []).length} total`
        );
        return result;
      } catch (e) {
        if (e.status === 429) {
          const wait = 60_000 * attempt;
          console.error(`[WARN] Rate limited, waiting ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        console.error(`[ERROR] ${model} attempt ${attempt} failed: ${e.message}`);
        if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  console.error("[ERROR] All models and attempts failed");
  return null;
}

function generateHtml(analysis) {
  const dateStr = analysis.date ?? new Date().toISOString().slice(0, 10);
  const parts = dateStr.split("-");
  const dateDisplay = parts.length === 3 ? `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日` : dateStr;
  const summary = escapeHtml(analysis.market_summary ?? "");
  const topPicks = analysis.top_picks ?? [];
  const allPapers = analysis.all_papers ?? [];
  const keywords = analysis.keywords ?? [];
  const topicDist = analysis.topic_distribution ?? {};
  const totalCount = topPicks.length + allPapers.length;

  const topPicksHtml = topPicks
    .map((p) => {
      const tags = (p.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      const util = p.clinical_utility ?? "中";
      const uClass = util === "高" ? "utility-high" : util === "低" ? "utility-low" : "utility-mid";
      const pico = p.pico ?? {};
      const picoHtml = Object.keys(pico).length
        ? `<div class="pico-grid">
            <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escapeHtml(pico.population ?? "-")}</span></div>
            <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escapeHtml(pico.intervention ?? "-")}</span></div>
            <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escapeHtml(pico.comparison ?? "-")}</span></div>
            <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escapeHtml(pico.outcome ?? "-")}</span></div>
          </div>`
        : "";
      return `<div class="news-card featured">
        <div class="card-header">
          <span class="rank-badge">#${p.rank ?? ""}</span>
          <span class="emoji-icon">${escapeHtml(p.emoji ?? "📄")}</span>
          <span class="${uClass}">${escapeHtml(util)}實用性</span>
        </div>
        <h3>${escapeHtml(p.title_zh ?? p.title_en ?? "")}</h3>
        <p class="journal-source">${escapeHtml(p.journal ?? "")} &middot; ${escapeHtml(p.title_en ?? "")}</p>
        <p>${escapeHtml(p.summary ?? "")}</p>
        ${picoHtml}
        <div class="card-footer">
          ${tags}
          <a href="${escapeHtml(p.url ?? "#")}" target="_blank" rel="noopener">閱讀原文 →</a>
        </div>
      </div>`;
    })
    .join("");

  const allPapersHtml = allPapers
    .map((p) => {
      const tags = (p.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      const util = p.clinical_utility ?? "中";
      const uClass = util === "高" ? "utility-high" : util === "低" ? "utility-low" : "utility-mid";
      return `<div class="news-card">
        <div class="card-header-row">
          <span class="emoji-sm">${escapeHtml(p.emoji ?? "📄")}</span>
          <span class="${uClass} utility-sm">${escapeHtml(util)}</span>
        </div>
        <h3>${escapeHtml(p.title_zh ?? p.title_en ?? "")}</h3>
        <p class="journal-source">${escapeHtml(p.journal ?? "")}</p>
        <p>${escapeHtml(p.summary ?? "")}</p>
        <div class="card-footer">
          ${tags}
          <a href="${escapeHtml(p.url ?? "#")}" target="_blank" rel="noopener">PubMed →</a>
        </div>
      </div>`;
    })
    .join("");

  const keywordsHtml = keywords.map((k) => `<span class="keyword">${escapeHtml(k)}</span>`).join("");
  const maxCount = Math.max(1, ...Object.values(topicDist));
  const topicBarsHtml = Object.entries(topicDist)
    .map(
      ([topic, count]) => `<div class="topic-row">
        <span class="topic-name">${escapeHtml(topic)}</span>
        <div class="topic-bar-bg"><div class="topic-bar" style="width:${Math.round((count / maxCount) * 100)}%"></div></div>
        <span class="topic-count">${count}</span>
      </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>TMJ Disorder Daily &middot; 顳顎關節障礙文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 顳顎關節障礙文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 120px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .clinic-banner { margin-top: 48px; animation: fadeUp 0.5s ease 0.3s both; }
  .clinic-links { display: flex; flex-direction: column; gap: 10px; }
  .clinic-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .clinic-link:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .clinic-icon { font-size: 28px; flex-shrink: 0; }
  .clinic-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .clinic-desc { font-size: 12px; color: var(--muted); font-weight: 400; }
  .clinic-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 80px; font-size: 11px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">🦷</div>
    <div class="header-text">
      <h1>TMJ Disorder Daily &middot; 顳顎關節障礙文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">📅 ${dateDisplay}</span>
        <span class="badge badge-count">📊 ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + NVIDIA AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>📋 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topPicksHtml ? `<div class="section"><div class="section-title"><span class="section-icon">⭐</span>今日精選 TOP Picks</div>${topPicksHtml}</div>` : ""}

  ${allPapersHtml ? `<div class="section"><div class="section-title"><span class="section-icon">📚</span>其他值得關注的文獻</div>${allPapersHtml}</div>` : ""}

  ${topicBarsHtml ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">📊</span>主題分佈</div>${topicBarsHtml}</div>` : ""}

  ${keywordsHtml ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">🏷️</span>關鍵字</div><div class="keywords">${keywordsHtml}</div></div>` : ""}

  <div class="clinic-banner">
    <div class="clinic-links">
      <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
        <span class="clinic-icon">🏥</span>
        <span class="clinic-name">李政洋身心診所首頁</span>
        <span class="clinic-arrow">→</span>
      </a>
      <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
        <span class="clinic-icon">📬</span>
        <span class="clinic-name">訂閱電子報<span class="clinic-desc"> &middot; 最新身心醫學資訊</span></span>
        <span class="clinic-arrow">→</span>
      </a>
      <a href="https://buymeacoffee.com/CYlee" class="clinic-link" target="_blank" rel="noopener">
        <span class="clinic-icon">☕</span>
        <span class="clinic-name">Buy Me a Coffee<span class="clinic-desc"> &middot; 支持本研究計畫</span></span>
        <span class="clinic-arrow">→</span>
      </a>
    </div>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${MODELS[0]}</span>
    <span><a href="https://github.com/u8901006/TMJ-disorder">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

function loadSummarizedPmids() {
  const path = resolve(DOCS, ".summarized_pmids.json");
  if (!existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return new Set(data.pmids ?? []);
  } catch {
    return new Set();
  }
}

function saveSummarizedPmids(pmids) {
  const path = resolve(DOCS, ".summarized_pmids.json");
  writeFileSync(path, JSON.stringify({ pmids: [...pmids] }, null, 2), "utf-8");
}

async function main() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    console.error("[ERROR] NVIDIA_API_KEY environment variable is required");
    process.exit(1);
  }

  const inputPath = resolve(ROOT, "papers.json");
  if (!existsSync(inputPath)) {
    console.error("[ERROR] papers.json not found. Run fetch_papers.mjs first.");
    process.exit(1);
  }

  const papersData = loadPapers(inputPath);
  const dateStr = papersData.date;
  const outputPath = resolve(DOCS, `tmj-${dateStr}.html`);

  if (!papersData.papers?.length) {
    console.error("[WARN] No papers found, generating empty report");
    const emptyAnalysis = {
      date: dateStr,
      market_summary: "今日 PubMed 暫無新的顳顎關節障礙（TMJ Disorder）文獻更新。請明天再查看。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
    const html = generateHtml(emptyAnalysis);
    writeFileSync(outputPath, html, "utf-8");
    console.error(`[INFO] Empty report saved to ${outputPath}`);
    return;
  }

  const analysis = await analyzePapers(apiKey, papersData);
  if (!analysis) {
    console.error("[ERROR] AI analysis failed");
    process.exit(1);
  }

  const html = generateHtml(analysis);
  writeFileSync(outputPath, html, "utf-8");
  console.error(`[INFO] Report saved to ${outputPath}`);

  const summarized = loadSummarizedPmids();
  const newPmids = papersData.new_pmids ?? papersData.papers.map((p) => p.pmid);
  for (const pmid of newPmids) {
    if (pmid) summarized.add(pmid);
  }
  saveSummarizedPmids(summarized);
  console.error(`[INFO] Updated summarized PMIDs (total: ${summarized.size})`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
