import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DOCS = resolve(ROOT, "docs");

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const USER_AGENT = "TMJDisorderBot/1.0 (research aggregator)";

const TMJ_CORE_QUERY = [
  '"Temporomandibular Joint Disorders"[MeSH]',
  '"Temporomandibular Joint Dysfunction Syndrome"[MeSH]',
  "temporomandibular disorder*[tiab]",
  "temporomandibular joint disorder*[tiab]",
  "TMD[tiab]",
  "TMJ disorder*[tiab]",
  "TMJD[tiab]",
  "craniomandibular disorder*[tiab]",
  "orofacial pain[tiab]",
  "jaw pain[tiab]",
].join(" OR ");

const TOPIC_QUERIES = [
  TMJ_CORE_QUERY,
  `(${TMJ_CORE_QUERY}) AND (anxiety[tiab] OR depression[tiab] OR stress[tiab] OR catastrophizing[tiab] OR somatization[tiab] OR psychological distress[tiab])`,
  `(${TMJ_CORE_QUERY}) AND (central sensitization[tiab] OR nociplastic pain[tiab] OR conditioned pain modulation[tiab] OR quantitative sensory testing[tiab] OR pressure pain threshold[tiab])`,
  `(${TMJ_CORE_QUERY}) AND (bruxism[tiab] OR sleep bruxism[tiab] OR clenching[tiab] OR parafunction*[tiab])`,
  `(${TMJ_CORE_QUERY}) AND (headache[tiab] OR migraine[tiab] OR tension-type headache[tiab])`,
  `(${TMJ_CORE_QUERY}) AND (cognitive behavioral therap*[tiab] OR CBT[tiab] OR mindfulness[tiab] OR biofeedback[tiab] OR self-management[tiab])`,
  `(${TMJ_CORE_QUERY}) AND (physical therapy[tiab] OR physiotherapy[tiab] OR manual therapy[tiab] OR exercise therapy[tiab])`,
  `(${TMJ_CORE_QUERY}) AND (systematic review[pt] OR meta-analysis[pt])`,
];

function getDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10).replace(/-/g, "/");
}

function buildQuery(days) {
  const from = getDateNDaysAgo(days);
  return `(${TMJ_CORE_QUERY}) AND "${from}"[Date - Publication] : "3000"[Date - Publication]`;
}

async function pubmedGet(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`PubMed API ${resp.status}: ${resp.statusText}`);
  return resp.text();
}

async function searchPmids(query, retmax = 50) {
  const params = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmax: String(retmax),
    sort: "date",
    retmode: "json",
  });
  const text = await pubmedGet(`${PUBMED_SEARCH}?${params}`);
  const data = JSON.parse(text);
  return data?.esearchresult?.idlist ?? [];
}

function extractXmlField(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function extractAllXmlFields(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

function extractAbstract(articleXml) {
  const parts = [];
  const absTexts = extractAllXmlFields(articleXml, "AbstractText");
  for (const raw of absTexts) {
    const labelMatch = raw.match(/^<AbstractText[^>]*Label="([^"]*)"/);
    const text = raw.replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    if (labelMatch?.[1]) {
      parts.push(`${labelMatch[1]}: ${text}`);
    } else {
      parts.push(text);
    }
  }
  return parts.join(" ").slice(0, 2000);
}

function parseArticles(xmlData) {
  const articles = [];
  const articleBlocks = xmlData.split(/<PubmedArticle>/).slice(1);
  for (const block of articleBlocks) {
    try {
      const title = extractXmlField(block, "ArticleTitle").replace(/<[^>]+>/g, "");
      if (!title) continue;
      const abstract = extractAbstract(block);
      const journal = extractXmlField(block, "<Title");
      const journalFull = block.match(/<Title[^>]*>([\s\S]*?)<\/Title>/);
      const journalName = journalFull ? journalFull[1].trim() : "";
      const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
      const pmid = pmidMatch ? pmidMatch[1] : "";
      const yearMatch = block.match(/<Year>(\d{4})<\/Year>/);
      const monthMatch = block.match(/<Month>(\d{1,2})<\/Month>/);
      const dayMatch = block.match(/<Day>(\d{1,2})<\/Day>/);
      const dateParts = [yearMatch?.[1], monthMatch?.[1], dayMatch?.[1]].filter(Boolean);
      const keywords = extractAllXmlFields(block, "Keyword").map((k) => k.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
      articles.push({
        pmid,
        title,
        journal: journalName,
        date: dateParts.join("-"),
        abstract,
        url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
        keywords,
      });
    } catch {
      continue;
    }
  }
  return articles;
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const chunks = [];
  for (let i = 0; i < pmids.length; i += 100) {
    chunks.push(pmids.slice(i, i + 100));
  }
  const allPapers = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      db: "pubmed",
      id: chunk.join(","),
      retmode: "xml",
    });
    const xml = await pubmedGet(`${PUBMED_FETCH}?${params}`);
    allPapers.push(...parseArticles(xml));
  }
  return allPapers;
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
  const days = parseInt(process.env.FETCH_DAYS ?? "7", 10);
  const maxPapers = parseInt(process.env.MAX_PAPERS ?? "50", 10);

  console.error(`[INFO] Searching PubMed for TMJ papers from last ${days} days...`);

  const allPmids = new Set();
  const query = buildQuery(days);
  const pmids = await searchPmids(query, maxPapers);
  pmids.forEach((id) => allPmids.add(id));

  if (TOPIC_QUERIES.length > 1) {
    for (let i = 1; i < TOPIC_QUERIES.length; i++) {
      try {
        const topicQuery = `(${TOPIC_QUERIES[i]}) AND "${getDateNDaysAgo(days)}"[Date - Publication] : "3000"[Date - Publication]`;
        const topicPmids = await searchPmids(topicQuery, 15);
        topicPmids.forEach((id) => allPmids.add(id));
      } catch (e) {
        console.error(`[WARN] Topic query ${i} failed: ${e.message}`);
      }
    }
  }

  console.error(`[INFO] Found ${allPmids.size} unique PMIDs`);

  if (allPmids.size === 0) {
    const tz = new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" });
    const dateStr = new Date(tz).toISOString().slice(0, 10);
    const output = { date: dateStr, count: 0, papers: [] };
    writeFileSync(resolve(ROOT, "papers.json"), JSON.stringify(output, null, 2), "utf-8");
    console.error("[INFO] No papers found");
    return;
  }

  const papers = await fetchDetails([...allPmids].slice(0, maxPapers + 30));
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const summarized = loadSummarizedPmids();
  const newPapers = papers.filter((p) => !summarized.has(p.pmid));
  console.error(`[INFO] After dedup: ${newPapers.length} new papers (filtered ${papers.length - newPapers.length} already summarized)`);

  const tz = new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" });
  const dateStr = new Date(tz).toISOString().slice(0, 10);
  const output = {
    date: dateStr,
    count: newPapers.length,
    new_pmids: newPapers.map((p) => p.pmid),
    papers: newPapers,
  };

  writeFileSync(resolve(ROOT, "papers.json"), JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved ${newPapers.length} new papers to papers.json`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
