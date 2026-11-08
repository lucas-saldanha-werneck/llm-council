#!/usr/bin/env node
// LLM Council: 3-stage multi-vendor deliberation via OpenRouter.
// Stage 1: every council model answers the question independently (parallel).
// Stage 2: each model reviews and ranks the anonymized answers (parallel).
// Stage 3: the chairman synthesizes everything into one final answer.
// Idea from Andrej Karpathy's llm-council: https://github.com/karpathy/llm-council
//
// Usage: node council.mjs [--dry-run] --question-file <file>   (use - to read stdin)
//        node council.mjs [--dry-run] "your question"
//        node council.mjs --show-config

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_DIR = process.env.LLM_COUNCIL_DIR || path.join(os.homedir(), ".config", "llm-council");
const SESSIONS_DIR = path.join(USER_DIR, "sessions");
const API_URL = process.env.LLM_COUNCIL_API_URL || "https://openrouter.ai/api/v1/chat/completions";

// ---------- Config: bundled defaults < user config file < env vars ----------
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    console.error(`ERROR: cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
}

function loadConfig() {
  const cfg = readJson(path.join(SKILL_DIR, "config.json"));
  const user = readJson(path.join(USER_DIR, "config.json"));
  if (user) {
    for (const [k, v] of Object.entries(user)) {
      cfg[k] = (k === "max_tokens" && v && typeof v === "object") ? { ...cfg.max_tokens, ...v } : v;
    }
  }
  if (process.env.LLM_COUNCIL_MODELS) {
    cfg.council = process.env.LLM_COUNCIL_MODELS.split(",").map(s => s.trim()).filter(Boolean)
      .map(model => ({ model }));
  }
  if (process.env.LLM_COUNCIL_CHAIRMAN) {
    cfg.chairman = { model: process.env.LLM_COUNCIL_CHAIRMAN.trim() };
  }
  if (!Array.isArray(cfg.council) || cfg.council.length < 2 || !cfg.chairman?.model) {
    console.error("ERROR: config needs at least 2 council models and a chairman model.");
    process.exit(1);
  }
  return cfg;
}
const CONFIG = loadConfig();

// ---------- CLI ----------
const argv = process.argv.slice(2);
if (argv.includes("--show-config")) {
  console.log(JSON.stringify({ ...CONFIG, user_dir: USER_DIR }, null, 2));
  process.exit(0);
}
const USAGE = 'Usage: node council.mjs [--dry-run] --question-file <file>   (use - to read stdin)\n' +
  '       node council.mjs [--dry-run] "your question"\n       node council.mjs --show-config';
const DRY_RUN = argv.includes("--dry-run");
const rest = argv.filter(a => a !== "--dry-run");
let question;
const qfIndex = rest.indexOf("--question-file");
if (qfIndex !== -1) {
  const file = rest[qfIndex + 1];
  if (!file || rest.length !== 2) {
    console.error(`ERROR: --question-file takes one file path and no other words.\n${USAGE}`);
    process.exit(1);
  }
  try {
    question = fs.readFileSync(file === "-" ? 0 : file, "utf8").trim();
  } catch (e) {
    console.error(`ERROR: cannot read the question file: ${e.message}`);
    process.exit(1);
  }
} else {
  question = rest.join(" ").trim();
}
if (!question) {
  console.error(USAGE);
  process.exit(1);
}

// ---------- API key: env var first, then <user dir>/.env ----------
function loadApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  const envFile = path.join(USER_DIR, ".env");
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, "utf8").match(/OPENROUTER_API_KEY\s*=\s*["']?([^\s"']+)/);
    if (m) return m[1];
  }
  return null;
}
const API_KEY = DRY_RUN ? "dry" : loadApiKey();
if (!API_KEY) {
  console.error(
    "ERROR: no OpenRouter API key found.\n" +
    "Set OPENROUTER_API_KEY in the environment Claude Code runs in, or save it to a file:\n" +
    `  mkdir -p "${USER_DIR}"\n` +
    `  printf 'OPENROUTER_API_KEY=%s\\n' "PASTE_YOUR_KEY" > "${USER_DIR}/.env"\n` +
    `  chmod 600 "${USER_DIR}/.env"\n` +
    "Create a key at https://openrouter.ai/keys (the account needs credits)."
  );
  process.exit(2);
}

// ---------- Transcript folder: check it before any paid call ----------
try {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  fs.accessSync(SESSIONS_DIR, fs.constants.W_OK);
} catch (e) {
  console.error(`ERROR: cannot save transcripts in ${SESSIONS_DIR}: ${e.message}\n` +
    "Nothing was sent to OpenRouter. Fix the folder or set LLM_COUNCIL_DIR to a writable folder.");
  process.exit(4);
}

// ---------- OpenRouter call with fallback ----------
let totalCost = 0;
let totalTokens = 0;

async function callModel(spec, messages, maxTokens) {
  if (DRY_RUN) {
    // Rank the labels that are really in the prompt, so the fake ballot is valid for any council size.
    const labels = [...String(messages[1]?.content).matchAll(/^### Answer ([A-Z])$/gm)].map(m => m[1]);
    return {
      model: spec.model,
      content: `[dry-run] Simulated answer from ${spec.model}.` + (labels.length ? " " +
        JSON.stringify({ ranking: labels, assessments: Object.fromEntries(labels.map(l => [l, "simulated"])) }) : ""),
      cost: 0, tokens: 0, truncated: false,
    };
  }
  const attempt = async (model) => {
    const res = await fetch(API_URL, {
      method: "POST",
      signal: AbortSignal.timeout(CONFIG.timeout_ms || 240000),
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "llm-council-claude-code",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: CONFIG.temperature ?? 0.7,
        usage: { include: true },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      const err = new Error(`${model}: ${msg}`);
      err.modelNotFound = res.status === 404 || res.status === 400 || /not.*(found|valid|exist)/i.test(msg);
      throw err;
    }
    if (data.usage) {
      totalCost += data.usage.cost || 0;
      totalTokens += data.usage.total_tokens || 0;
    }
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error(`${model}: empty answer`);
    // "length" means the model hit max_tokens and the answer is cut off.
    const truncated = data.choices[0].finish_reason === "length";
    if (truncated) console.error(`  warning: ${model}: answer cut off at the output token limit (${maxTokens})`);
    return { model, content, truncated, cost: data.usage?.cost || 0, tokens: data.usage?.total_tokens || 0 };
  };
  try {
    return await attempt(spec.model);
  } catch (e) {
    if (spec.fallback && e.modelNotFound) {
      console.error(`  warning: ${e.message}; using fallback ${spec.fallback}`);
      return await attempt(spec.fallback);
    }
    throw e;
  }
}

// ---------- Prompts ----------
const LANG_RULE = "Answer in the same language as the user's question.";

function answerPrompt(q) {
  return [
    { role: "system", content: `You are a member of an LLM council. Give your best answer: accurate, with your own insight. ${LANG_RULE}` },
    { role: "user", content: q },
  ];
}

function reviewPrompt(q, labeled) {
  const block = labeled.map(l => `### Answer ${l.label}\n${l.content}`).join("\n\n");
  return [
    { role: "system", content:
      "You are an impartial reviewer on an LLM council. The answers below are anonymized " +
      "(one of them may be yours; judge impartially). Rate them on accuracy and depth of insight. " +
      "Return ONLY valid JSON, no markdown, in this format: " +
      '{"ranking": ["<best label>", "...", "<worst label>"], "assessments": {"<label>": "<1-2 sentence assessment>"}}' },
    { role: "user", content: `Original question:\n${q}\n\nAnswers to review:\n\n${block}` },
  ];
}

function chairmanPrompt(q, labeled, reviews) {
  const answers = labeled.map(l => `### Answer ${l.label} (${l.model})\n${l.content}`).join("\n\n");
  const revs = reviews.map(r =>
    `#### Review by ${r.reviewer}\n${r.parsed ? JSON.stringify(r.parsed) : r.raw}`).join("\n\n");
  return [
    { role: "system", content:
      "You are the Chairman of an LLM council. You have every member's answer and the cross-reviews. " +
      "Synthesize the single BEST final answer: use each member's strongest points, fix the errors the reviews found, " +
      `and settle disagreements with your own judgment. If members disagree in a way that matters, end with a short "Disagreements" section. ${LANG_RULE}` },
    { role: "user", content: `Original question:\n${q}\n\n## Member answers\n\n${answers}\n\n## Cross-reviews\n\n${revs}` },
  ];
}

// ---------- Helpers ----------
const CUT_NOTE = "[This answer was cut off at the output token limit.]";

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Pipeline ----------
const log = (s) => console.error(s); // progress on stderr; result on stdout

log(`\nLLM Council: ${CONFIG.council.length} members | chairman: ${CONFIG.chairman.model}${DRY_RUN ? " [DRY-RUN]" : ""}`);

// Stage 1
log("\n[1/3] Collecting individual answers...");
const s1 = await Promise.allSettled(
  CONFIG.council.map(spec => callModel(spec, answerPrompt(question), CONFIG.max_tokens.answer))
);
const answers = [];
s1.forEach((r, i) => {
  const wanted = CONFIG.council[i].model;
  if (r.status === "fulfilled") {
    // Tell reviewers and the chairman when a member answer is incomplete.
    if (r.value.truncated) r.value.content += `\n\n${CUT_NOTE}`;
    answers.push(r.value);
    log(`  ok: ${r.value.model}`);
  } else {
    log(`  FAILED: ${wanted}: ${r.reason.message}`);
  }
});
if (answers.length < 2) {
  console.error("\nERROR: fewer than 2 members answered; council aborted.");
  process.exit(3);
}

// Anonymize (shuffled labels A, B, C...)
const labeled = shuffle(answers).map((a, i) => ({
  label: String.fromCharCode(65 + i), model: a.model, content: a.content,
}));

// Stage 2
log("\n[2/3] Anonymous cross-review...");
const s2 = await Promise.allSettled(
  answers.map(a => callModel(
    CONFIG.council.find(c => c.model === a.model || c.fallback === a.model) || { model: a.model },
    reviewPrompt(question, labeled), CONFIG.max_tokens.review
  ))
);
const reviews = [];
s2.forEach((r, i) => {
  if (r.status === "fulfilled") {
    reviews.push({ reviewer: answers[i].model, raw: r.value.content, parsed: extractJson(r.value.content) });
    log(`  ok: ${answers[i].model}`);
  } else {
    log(`  FAILED: ${answers[i].model}: ${r.reason.message}`);
  }
});

// Aggregate ranking (mean position; lower = better).
// A ballot counts only if it ranks every answer exactly once; anything else is ignored.
const allLabels = labeled.map(l => l.label).sort().join(",");
const isValidBallot = (ranking) => Array.isArray(ranking) && ranking.length === labeled.length &&
  ranking.every(x => typeof x === "string") && [...ranking].sort().join(",") === allLabels;
const rankSum = {};
let validBallots = 0;
for (const rev of reviews) {
  const ranking = rev.parsed?.ranking;
  if (!isValidBallot(ranking)) {
    log(`  warning: ignoring the ranking from ${rev.reviewer}: it does not rank every answer exactly once`);
    continue;
  }
  validBallots++;
  ranking.forEach((label, pos) => { rankSum[label] = (rankSum[label] || 0) + pos + 1; });
}
const board = validBallots ? labeled.map(l => ({ ...l, mean: rankSum[l.label] / validBallots }))
  .sort((a, b) => a.mean - b.mean) : [];
const rankingNote = validBallots
  ? `Valid rankings: ${validBallots} of ${reviews.length} reviews.`
  : `Ranking unavailable: ${validBallots} of ${reviews.length} reviews gave a complete ranking.`;

// Stage 3
log("\n[3/3] Chairman synthesizing...");
let finalAnswer;
try {
  const res = await callModel(CONFIG.chairman, chairmanPrompt(question, labeled, reviews), CONFIG.max_tokens.final);
  finalAnswer = res.content;
  if (res.truncated) {
    finalAnswer += `\n\n**Warning:** the chairman's answer was cut off at the output token limit ` +
      `(max_tokens.final = ${CONFIG.max_tokens.final}). Raise it in the config to get the full answer.`;
  }
  log(`  ok: ${res.model}`);
} catch (e) {
  console.error(`\nERROR from chairman: ${e.message}`);
  finalAnswer = "(Chairman unavailable; see the individual answers in the transcript.)";
}

// ---------- Transcript ----------
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const slug = question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 50).replace(/^-|-$/g, "");
const t = [];
t.push(`# LLM Council: ${new Date().toISOString()}\n`);
t.push(`**Question:** ${question}\n`);
t.push(`## Final answer (Chairman: ${CONFIG.chairman.model})\n\n${finalAnswer}\n`);
t.push(`## Aggregate ranking\n`);
board.forEach((b, i) => t.push(`${i + 1}. **${b.model}** (Answer ${b.label}): mean position ${b.mean.toFixed(2)}`));
t.push(`\n${rankingNote}`);
t.push(`\n## Individual answers (stage 1)\n`);
labeled.forEach(l => t.push(`### ${l.label}: ${l.model}\n\n${l.content}\n`));
t.push(`## Cross-reviews (stage 2)\n`);
reviews.forEach(r => t.push(`### Reviewer: ${r.reviewer}\n\n\`\`\`\n${r.raw}\n\`\`\`\n`));
t.push(`---\nTotal cost: US$ ${totalCost.toFixed(4)} | Tokens: ${totalTokens}`);
// A random suffix plus exclusive create ("wx"): concurrent runs never overwrite each other.
// A failed save is reported, but the paid result is still printed below.
let transcriptPath = null, transcriptError = null;
for (let tries = 0; tries < 5 && !transcriptPath; tries++) {
  const name = [stamp, slug, crypto.randomBytes(4).toString("hex")].filter(Boolean).join("-") + ".md";
  const file = path.join(SESSIONS_DIR, name);
  try {
    fs.writeFileSync(file, t.join("\n"), { mode: 0o600, flag: "wx" });
    transcriptPath = file;
  } catch (e) {
    transcriptError = e;
    if (e.code !== "EEXIST") break;
  }
}
if (!transcriptPath) console.error(`\nERROR: transcript not saved: ${transcriptError.message}`);

// ---------- Result (stdout) ----------
const out = [];
out.push(`## Council final answer\n`);
out.push(finalAnswer);
out.push(`\n## Ranking (anonymous cross-review)\n`);
if (board.length) {
  out.push(`| # | Model | Answer | Mean position |`);
  out.push(`|---|-------|--------|---------------|`);
  board.forEach((b, i) => out.push(`| ${i + 1} | ${b.model} | ${b.label} | ${b.mean.toFixed(2)} |`));
  out.push("");
}
out.push(rankingNote);
out.push(`\nCost: US$ ${totalCost.toFixed(4)} | Tokens: ${totalTokens} | ` +
  (transcriptPath ? `Full transcript: ${transcriptPath}` : `Transcript not saved: ${transcriptError.message}`));
console.log(out.join("\n"));
