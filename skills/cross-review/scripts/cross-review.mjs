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
// Per reviewer. The council's worst case is 3 stages x 240 s per call (its timeout_ms), plus a
// fallback retry: ~24 min. 25 min by default; raise it if you raised the council's timeout_ms.
const TIMEOUT_MS = Number(process.env.CROSS_REVIEW_TIMEOUT_MS) || 1500000;
const IS_WIN = process.platform === "win32";
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
opts.cd = path.resolve(opts.cd); // Codex gets cwd and -C; a relative path would apply twice.
if (!fs.existsSync(opts.cd) || !fs.statSync(opts.cd).isDirectory()) {
  console.error(`ERROR: --cd ${opts.cd} is not a folder.`);
  process.exit(1);
}

// One prompt, used word for word by both reviewers.
// The council names its transcript after the first words of the question, so the plan's
// first line goes first: otherwise every transcript would get the same name.
const TITLE = plan.split("\n").find(l => l.trim()).replace(/\s+/g, " ").trim().slice(0, 60);
const PROMPT = [
  `Plan review: ${TITLE}`,
  "",
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
const isJs = f => /\.(m?js|cjs)$/i.test(f);
function usable(f) {
  try {
    if (!fs.statSync(f).isFile()) return false;
    if (!IS_WIN && !isJs(f)) fs.accessSync(f, fs.constants.X_OK); // a non-executable file is not a program
    return true;
  } catch { return false; }
}

function findOnPath(name) {
  if (path.isAbsolute(name)) return usable(name) ? name : null;
  const exts = IS_WIN
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean).concat([""])
    : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase());
      const q = path.join(dir, name + ext);
      for (const c of [p, q]) {
        if (usable(c)) return c;
      }
    }
  }
  return null;
}

// cmd.exe quoting for a .cmd shim (same rules as cross-spawn): quote for the program's own
// argv parser, then caret-escape every cmd metacharacter (% and ! included) twice, once for
// `cmd /c` and once for the shim's own `%*` line.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const cmdArg = s => `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`
  .replace(CMD_META, "^$1").replace(CMD_META, "^$1");

const running = new Set();
function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (IS_WIN) spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGKILL"); // the whole process group, grandchildren included
  } catch { /* already gone */ }
}

// Runs a program; stdin text optional. JS files run with this Node (lets tests use a fake codex.mjs).
// Resolves {code, signal, timedOut, stdout, stderr}; on timeout it resolves right away, even if
// a grandchild still holds the pipes open.
function runProgram(file, args, { input = "", cwd, onStderr } = {}) {
  return new Promise(resolve => {
    let cmd = file, cmdArgs = args, extra = {};
    if (isJs(file)) { cmd = process.execPath; cmdArgs = [file, ...args]; }
    else if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
      // .cmd needs cmd.exe. Only fixed flags and paths go on this line, never the plan.
      cmd = process.env.ComSpec || "cmd.exe";
      cmdArgs = ["/d", "/s", "/c", `"${[file.replace(CMD_META, "^$1"), ...args.map(cmdArg)].join(" ")}"`];
      extra = { windowsVerbatimArguments: true };
    }
    let stdout = "", stderr = "", done = false, timedOut = false;
    // POSIX: its own process group, so a timeout can kill everything it started.
    const child = spawn(cmd, cmdArgs, { cwd, windowsHide: true, detached: !IS_WIN, ...extra });
    running.add(child);
    const finish = (code, signal) => {
      if (done) return;
      done = true; clearTimeout(timer); running.delete(child);
      resolve({ code, signal, timedOut, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      for (const s of [child.stdin, child.stdout, child.stderr]) s?.destroy();
      finish(null, null);
    }, TIMEOUT_MS);
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => { stderr += d; if (onStderr) onStderr(d); });
    child.on("error", e => { stderr += `\n${e.message}`; finish(127, null); });
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Status line for a reviewer that gave no usable answer.
function failure(r) {
  if (r.timedOut) return `timed out after ${TIMEOUT_MS / 1000} s (limit: CROSS_REVIEW_TIMEOUT_MS)`;
  if (r.signal) return `killed by ${r.signal}`;
  if (r.code === 0) return "answered with no text";
  return `failed (exit ${r.code})`;
}

const tail = (s, n = 15) => s.trim().split("\n").slice(-n).join("\n");

// ---------- reviewers ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-"));
// The temp folder holds the plan: remove it however the run ends, and stop the reviewers too.
process.on("exit", () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } });
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(sig, () => { for (const ch of running) killTree(ch); process.exit(code); });
}
const promptFile = path.join(work, "plan-review.txt");
fs.writeFileSync(promptFile, PROMPT, { mode: 0o600 });

async function council() {
  const args = [COUNCIL, ...(opts.dryRun ? ["--dry-run"] : []), "--question-file", promptFile];
  const r = await runProgram(process.execPath, args, { onStderr: d => process.stderr.write(`[council] ${d}`) });
  const text = r.stdout.trim();
  if (r.code === 0 && text) return { status: "ok", text };
  const status = failure(r);
  return { status, text: `The council ${status}:\n\n\`\`\`\n${tail(r.stderr || r.stdout) || "(no output)"}\n\`\`\`` };
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
  const status = failure(r);
  return { status, text: `Codex ${status}:\n\n\`\`\`\n${tail(r.stderr || r.stdout) || "(no output)"}\n\`\`\`` };
}

process.stderr.write(`Cross-review: council${opts.codex ? " + Codex" : ""} in parallel on the same text (${plan.length} chars)\n`);
const [c, x] = await Promise.all([council(), codex()]);
fs.rmSync(work, { recursive: true, force: true });

// ---------- transcript ----------
// Same rules as council.mjs: 0600, never overwrite (wx), a new random name if one already exists.
let transcript = null, transcriptError = null;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const body = [`# Cross-review ${stamp}`, "", "## Prompt sent to both", "", PROMPT, "",
  "## LLM council", "", c.text, "", "## Codex (read-only)", "", x.text, ""].join("\n");
try {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  for (let tries = 0; tries < 5 && !transcript; tries++) {
    const file = path.join(SESSIONS_DIR, `${stamp}-cross-review-${crypto.randomBytes(4).toString("hex")}.md`);
    try { fs.writeFileSync(file, body, { mode: 0o600, flag: "wx" }); transcript = file; }
    catch (e) { transcriptError = e; if (e.code !== "EEXIST") break; }
  }
} catch (e) { transcriptError = e; }
if (!transcript) process.stderr.write(`ERROR: cross-review transcript not saved: ${transcriptError.message}\n`);

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
