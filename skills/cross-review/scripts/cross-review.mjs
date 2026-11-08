#!/usr/bin/env node
// Cross-review: send the same plan to the LLM council and to Codex (read-only) at the same time,
// and print both answers together so Claude can merge them into one table of findings.
// Codex is optional: without the `codex` CLI the council runs alone and the output says so.
//
// Usage: node cross-review.mjs [--dry-run] [--no-codex] [--cd <dir>] --plan-file <file>   (- = stdin)
//
// Exit codes: 0 at least one reviewer answered; 1 bad arguments or unreadable plan;
//             5 no reviewer answered (the real errors are printed).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILLS = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const COUNCIL = path.join(SKILLS, "llm-council", "scripts", "council.mjs");
const USER_DIR = process.env.LLM_COUNCIL_DIR || path.join(os.homedir(), ".config", "llm-council");
const SESSIONS_DIR = path.join(USER_DIR, "sessions");
const TIMEOUT_MS = Number(process.env.CROSS_REVIEW_TIMEOUT_MS) || 900000;
const USAGE = "Usage: node cross-review.mjs [--dry-run] [--no-codex] [--cd <dir>] --plan-file <file>   (- = stdin)";

// ---------- CLI ----------
const argv = process.argv.slice(2);
const opts = { dryRun: false, codex: true, cd: process.cwd(), planFile: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--no-codex") opts.codex = false;
  else if (a === "--cd" && argv[i + 1]) opts.cd = argv[++i];
  else if (a === "--plan-file" && argv[i + 1]) opts.planFile = argv[++i];
  else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
  else { console.error(`ERROR: unexpected argument ${JSON.stringify(a)}\n${USAGE}`); process.exit(1); }
}
if (!opts.planFile) { console.error(`ERROR: --plan-file is required.\n${USAGE}`); process.exit(1); }
let plan;
try {
  plan = fs.readFileSync(opts.planFile === "-" ? 0 : opts.planFile, "utf8").trim();
} catch (e) {
  console.error(`ERROR: cannot read the plan file: ${e.message}`);
  process.exit(1);
}
if (!plan) { console.error("ERROR: the plan is empty."); process.exit(1); }
if (!fs.existsSync(opts.cd) || !fs.statSync(opts.cd).isDirectory()) {
  console.error(`ERROR: --cd ${opts.cd} is not a folder.`);
  process.exit(1);
}

// One prompt, used word for word by both reviewers.
const PROMPT = [
  "You are an independent, critical reviewer. Review the plan or decision below before anyone acts on it.",
  "Answer: Is it right? What is missing? What is the biggest risk? Is there a better option?",
  "If it compares options, say which one is best and why, and consider every option it lists.",
  "Do not change any file. Answer in the language of the plan.",
  "End with a list of findings, one per line, each tagged with a severity: high, medium or low.",
  "",
  "--- PLAN ---",
  plan,
  "--- END PLAN ---",
].join("\n");

// ---------- helpers ----------
function findOnPath(name) {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean).concat([""])
    : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase());
      const q = path.join(dir, name + ext);
      for (const c of [p, q]) {
        try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
      }
    }
  }
  return null;
}

// Runs a program; stdin text optional. JS files run with this Node (lets tests use a fake codex.mjs).
function runProgram(file, args, { input = "", cwd, onStderr } = {}) {
  return new Promise(resolve => {
    let cmd = file, cmdArgs = args, shell = false;
    if (/\.(m?js|cjs)$/i.test(file)) { cmd = process.execPath; cmdArgs = [file, ...args]; }
    else if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
      // .cmd needs a shell on Windows. Only fixed flags and paths go on this line, never the plan.
      shell = true;
      const q = s => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      cmd = q(file); cmdArgs = args.map(q);
    }
    let stdout = "", stderr = "", done = false;
    const child = spawn(cmd, cmdArgs, { cwd, shell, windowsHide: true });
    const timer = setTimeout(() => { child.kill(); stderr += `\n(timed out after ${TIMEOUT_MS} ms)`; }, TIMEOUT_MS);
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => { stderr += d; if (onStderr) onStderr(d); });
    const finish = code => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); };
    child.on("error", e => { stderr += `\n${e.message}`; finish(127); });
    child.on("close", code => finish(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const tail = (s, n = 15) => s.trim().split("\n").slice(-n).join("\n");

// ---------- reviewers ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-"));
const promptFile = path.join(work, "plan-review.txt");
fs.writeFileSync(promptFile, PROMPT, { mode: 0o600 });

async function council() {
  const args = [COUNCIL, ...(opts.dryRun ? ["--dry-run"] : []), "--question-file", promptFile];
  const r = await runProgram(process.execPath, args, { onStderr: d => process.stderr.write(`[council] ${d}`) });
  return r.code === 0
    ? { status: "ok", text: r.stdout.trim() }
    : { status: `failed (exit ${r.code})`, text: `The council failed (exit ${r.code}):\n\n\`\`\`\n${tail(r.stderr || r.stdout)}\n\`\`\`` };
}

async function codex() {
  if (!opts.codex) return { status: "skipped (--no-codex)", text: "Not run: --no-codex." };
  const bin = findOnPath(process.env.CROSS_REVIEW_CODEX || "codex");
  if (!bin) {
    return { status: "not installed", missing: true,
      text: "Not run: the `codex` CLI was not found on PATH, so this is a council-only review. " +
        "Install Codex (https://github.com/openai/codex) and sign in to add it." };
  }
  const outFile = path.join(work, "codex-last-message.md");
  const args = ["exec", "-s", "read-only", "--skip-git-repo-check", "--color", "never", "-C", opts.cd, "-o", outFile, "-"];
  if (opts.dryRun) {
    return { status: "dry-run", text: `[dry-run] Would run: codex ${args.join(" ")} (the plan on stdin)` };
  }
  process.stderr.write("[codex] running (read-only sandbox)...\n");
  const r = await runProgram(bin, args, { input: PROMPT, cwd: opts.cd });
  let last = "";
  try { last = fs.readFileSync(outFile, "utf8").trim(); } catch { /* fall back to stdout */ }
  const text = last || r.stdout.trim();
  if (r.code === 0 && text) return { status: "ok", text };
  return { status: `failed (exit ${r.code})`,
    text: `Codex failed (exit ${r.code}):\n\n\`\`\`\n${tail(r.stderr || r.stdout) || "(no output)"}\n\`\`\`` };
}

process.stderr.write(`Cross-review: council${opts.codex ? " + Codex" : ""} in parallel on the same text (${plan.length} chars)\n`);
const [c, x] = await Promise.all([council(), codex()]);
fs.rmSync(work, { recursive: true, force: true });

// ---------- transcript ----------
let transcript = null;
try {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(SESSIONS_DIR, `${stamp}-cross-review-${crypto.randomBytes(4).toString("hex")}.md`);
  fs.writeFileSync(file, [`# Cross-review ${stamp}`, "", "## Prompt sent to both", "", PROMPT, "",
    "## LLM council", "", c.text, "", "## Codex (read-only)", "", x.text, ""].join("\n"), { mode: 0o600, flag: "wx" });
  transcript = file;
} catch (e) {
  process.stderr.write(`ERROR: cross-review transcript not saved: ${e.message}\n`);
}

// ---------- result ----------
const ok = [c, x].filter(r => r.status === "ok" || r.status === "dry-run").length;
const out = [
  "# Cross-review",
  "",
  `Both reviewers got the same text: ${opts.planFile === "-" ? "the plan from stdin" : opts.planFile} (${plan.length} chars).` +
    (x.missing ? " Codex is not installed: this is a council-only review." : ""),
  "",
  "## LLM council",
  "",
  c.text,
  "",
  "## Codex (read-only)",
  "",
  x.text,
  "",
  "## Status",
  "",
  `- Council: ${c.status}`,
  `- Codex: ${x.status}`,
  transcript ? `- Cross-review transcript: ${transcript}` : "- Cross-review transcript: not saved",
];
console.log(out.join("\n"));
process.exit(ok ? 0 : 5);
