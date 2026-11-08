// Tests for council.mjs. No real API calls: a local HTTP server stands in for OpenRouter.
// Run: node --test tests/test_council.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "skills", "llm-council", "scripts", "council.mjs");

// Preference order the fake reviewers use, best first.
const PREFERENCE = ["openai/gpt-5.6-terra", "google/gemini-3.1-pro-preview", "x-ai/grok-4.5",
  "anthropic/claude-fable-5", "anthropic/claude-opus-4.8"];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llm-council-test-"));
}

// Labels in a review prompt, ordered by PREFERENCE (best first).
function preferredLabels(body) {
  const user = body.messages[1].content;
  const labels = [...user.matchAll(/### Answer ([A-Z])\nANSWER FROM (\S+)/g)]
    .map(m => ({ label: m[1], model: m[2] }));
  labels.sort((a, b) => PREFERENCE.indexOf(a.model) - PREFERENCE.indexOf(b.model));
  return labels.map(l => l.label);
}
const isReview = body => body.messages[0].content.includes("impartial reviewer");
const isChairman = body => body.messages[0].content.includes("Chairman");
const reply = (content, extra = {}) => ({
  status: 200,
  body: { choices: [{ message: { content }, ...extra }], usage: { cost: 0.01, total_tokens: 100 } },
});

// Fake OpenRouter. `behavior(model, body)` may return {status, body} to override the normal reply.
async function startServer(behavior = () => null) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ headers: req.headers, body });
      const override = behavior(body.model, body);
      if (override) {
        res.writeHead(override.status, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(override.body));
      }
      const system = body.messages[0].content;
      let content;
      if (system.includes("impartial reviewer")) {
        // Map each label to the model named in its answer, then rank by PREFERENCE.
        content = JSON.stringify({ ranking: preferredLabels(body), assessments: {} });
      } else if (system.includes("Chairman")) {
        content = "FINAL SYNTHESIS";
      } else {
        content = `ANSWER FROM ${body.model}`;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { cost: 0.01, total_tokens: 100 },
      }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/chat/completions`;
  return { url, requests, close: () => new Promise(r => server.close(r)) };
}

function run(args, env, input) {
  return new Promise(resolve => {
    const home = env.HOME || tmpDir();
    const clean = { PATH: process.env.PATH, HOME: home, ...env };
    const child = execFile(process.execPath, [SCRIPT, ...args], { env: clean, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

const TWO = { LLM_COUNCIL_MODELS: "openai/gpt-5.6-terra,x-ai/grok-4.5", LLM_COUNCIL_CHAIRMAN: "c/chair" };

test("dry run completes, prints the result and writes a transcript", async () => {
  const dir = tmpDir();
  const r = await run(["--dry-run", "Is this a test?"], { LLM_COUNCIL_DIR: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /## Council final answer/);
  assert.match(r.stdout, /\| # \| Model \| Answer \| Mean position \|/);
  const files = fs.readdirSync(path.join(dir, "sessions"));
  assert.equal(files.length, 1);
  assert.match(files[0], /is-this-a-test-[0-9a-f]{8}\.md$/);
});

test("no API key: exit code 2 with setup instructions", async () => {
  const r = await run(["hello"], { LLM_COUNCIL_DIR: tmpDir() });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no OpenRouter API key found/);
  assert.match(r.stderr, /OPENROUTER_API_KEY/);
});

test("no question: exit code 1 with usage", async () => {
  const r = await run([], { LLM_COUNCIL_DIR: tmpDir() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage:/);
});

test("full run against a fake OpenRouter: 3 stages, ranking, cost", async () => {
  const srv = await startServer();
  const dir = tmpDir();
  const r = await run(["Which is best?"], {
    LLM_COUNCIL_DIR: dir, LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "test-key",
  });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  // 4 answers + 4 reviews + 1 chairman
  assert.equal(srv.requests.length, 9);
  assert.equal(srv.requests[0].headers.authorization, "Bearer test-key");
  assert.match(r.stdout, /FINAL SYNTHESIS/);
  const rows = r.stdout.split("\n").filter(l => /^\| \d/.test(l));
  assert.equal(rows.length, 4);
  assert.match(rows[0], /\| 1 \| openai\/gpt-5\.6-terra \| [A-D] \| 1\.00 \|/);
  assert.match(rows[3], /anthropic\/claude-fable-5 \| [A-D] \| 4\.00 \|/);
  assert.match(r.stdout, /Cost: US\$ 0\.0900 \| Tokens: 900/);
  const transcript = fs.readFileSync(path.join(dir, "sessions", fs.readdirSync(path.join(dir, "sessions"))[0]), "utf8");
  assert.match(transcript, /ANSWER FROM x-ai\/grok-4\.5/);
});

test("API key is read from <LLM_COUNCIL_DIR>/.env", async () => {
  const srv = await startServer();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".env"), "OPENROUTER_API_KEY=file-key\n");
  const r = await run(["q"], { LLM_COUNCIL_DIR: dir, LLM_COUNCIL_API_URL: srv.url });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(srv.requests[0].headers.authorization, "Bearer file-key");
});

test("a model that returns 404 is replaced by its fallback", async () => {
  const srv = await startServer(model =>
    model === "anthropic/claude-fable-5" ? { status: 404, body: { error: { message: "No endpoints found" } } } : null);
  const r = await run(["q"], {
    LLM_COUNCIL_DIR: tmpDir(), LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k",
  });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /using fallback anthropic\/claude-opus-4\.8/);
  assert.match(r.stdout, /anthropic\/claude-opus-4\.8/);
});

test("fewer than 2 answers: exit code 3", async () => {
  const srv = await startServer(model =>
    model !== "x-ai/grok-4.5" ? { status: 402, body: { error: { message: "Insufficient credits" } } } : null);
  const r = await run(["q"], {
    LLM_COUNCIL_DIR: tmpDir(), LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k",
  });
  await srv.close();
  assert.equal(r.code, 3);
  assert.match(r.stderr, /fewer than 2 members answered/);
});

test("user config file and env vars override the defaults", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ temperature: 0.2, max_tokens: { review: 500 } }));
  const r = await run(["--show-config"], {
    LLM_COUNCIL_DIR: dir, LLM_COUNCIL_MODELS: "a/one, b/two", LLM_COUNCIL_CHAIRMAN: "c/three",
  });
  assert.equal(r.code, 0, r.stderr);
  const cfg = JSON.parse(r.stdout);
  assert.deepEqual(cfg.council, [{ model: "a/one" }, { model: "b/two" }]);
  assert.deepEqual(cfg.chairman, { model: "c/three" });
  assert.equal(cfg.temperature, 0.2);
  assert.deepEqual(cfg.max_tokens, { answer: 8000, review: 500, final: 12000 });
});

test("a council with one model is rejected: exit code 1", async () => {
  const r = await run(["--show-config"], { LLM_COUNCIL_DIR: tmpDir(), LLM_COUNCIL_MODELS: "a/one" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /at least 2 council models/);
});

test("chairman failure still prints the ranking and writes the transcript", async () => {
  const dir = tmpDir();
  const srv = await startServer(model =>
    model === "c/chair" ? { status: 500, body: { error: { message: "boom" } } } : null);
  const r = await run(["q"], {
    LLM_COUNCIL_DIR: dir, LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k",
    LLM_COUNCIL_MODELS: "openai/gpt-5.6-terra,x-ai/grok-4.5", LLM_COUNCIL_CHAIRMAN: "c/chair",
  });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Chairman unavailable/);
  assert.match(r.stdout, /\| 1 \| openai\/gpt-5\.6-terra \|/);
  assert.equal(fs.readdirSync(path.join(dir, "sessions")).length, 1);
});

// ---------- Round-2 audit regressions ----------

test("--question-file reads the question from a file, with shell characters kept literally", async () => {
  const srv = await startServer();
  const dir = tmpDir();
  const q = 'Is `echo $(whoami)` safe? Say "no".\nSecond line.';
  const qf = path.join(dir, "question.txt");
  fs.writeFileSync(qf, q);
  const r = await run(["--question-file", qf], {
    LLM_COUNCIL_DIR: dir, LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k",
  });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(srv.requests[0].body.messages[1].content, q);
});

test("--question-file - reads the question from stdin", async () => {
  const srv = await startServer();
  const q = "From stdin: $HOME and `id`";
  const r = await run(["--question-file", "-"], {
    LLM_COUNCIL_DIR: tmpDir(), LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k",
  }, q);
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(srv.requests[0].body.messages[1].content, q);
});

test("SKILL.md never tells Claude to put the question inside a shell command", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills", "llm-council", "SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /council\.mjs" "the user's question"/);
  assert.match(skill, /--question-file/);
});

test("an incomplete ballot is ignored and the valid count is shown", async () => {
  const srv = await startServer((model, body) => {
    if (!isReview(body)) return null;
    const best = preferredLabels(body);
    // grok ranks only its own answer: an incomplete ballot.
    if (model === "x-ai/grok-4.5") return reply(JSON.stringify({ ranking: [best[1]] }));
    return null;
  });
  const r = await run(["q"], { LLM_COUNCIL_DIR: tmpDir(), LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k", ...TWO });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  const rows = r.stdout.split("\n").filter(l => /^\| \d/.test(l));
  assert.match(rows[0], /openai\/gpt-5\.6-terra \| [AB] \| 1\.00 \|/);
  assert.match(rows[1], /x-ai\/grok-4\.5 \| [AB] \| 2\.00 \|/);
  assert.match(r.stdout, /Valid rankings: 1 of 2 reviews/);
});

test("a ballot with a repeated label is ignored", async () => {
  const srv = await startServer((model, body) => {
    if (!isReview(body)) return null;
    const best = preferredLabels(body);
    if (model === "x-ai/grok-4.5") return reply(JSON.stringify({ ranking: [best[1], best[1]] }));
    return null;
  });
  const r = await run(["q"], { LLM_COUNCIL_DIR: tmpDir(), LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k", ...TWO });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /x-ai\/grok-4\.5 \| [AB] \| 2\.00 \|/);
  assert.match(r.stdout, /Valid rankings: 1 of 2 reviews/);
});

test("no valid ballot: the ranking is reported as unavailable, not numbered", async () => {
  const srv = await startServer((model, body) => isReview(body) ? reply("I liked them all.") : null);
  const r = await run(["q"], { LLM_COUNCIL_DIR: tmpDir(), LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k", ...TWO });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Ranking unavailable: 0 of 2 reviews gave a complete ranking/);
  assert.equal(r.stdout.split("\n").filter(l => /^\| \d/.test(l)).length, 0);
});

test("concurrent runs of the same question never overwrite each other's transcript", async () => {
  const srv = await startServer();
  const dir = tmpDir();
  const env = { LLM_COUNCIL_DIR: dir, LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k", ...TWO };
  const results = await Promise.all([1, 2, 3, 4].map(() => run(["same question"], env)));
  await srv.close();
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const files = fs.readdirSync(path.join(dir, "sessions"));
  assert.equal(files.length, 4);
  const printed = results.map(r => r.stdout.match(/Full transcript: (.+)$/m)[1]);
  assert.equal(new Set(printed).size, 4);
  for (const p of printed) assert.ok(fs.existsSync(p), p);
});

test("an unusable transcript folder stops the run before any paid call", async () => {
  const srv = await startServer();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "sessions"), "not a folder");
  const r = await run(["q"], { LLM_COUNCIL_DIR: dir, LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k", ...TWO });
  await srv.close();
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /cannot save transcripts/);
  assert.equal(srv.requests.length, 0);
});

test("a transcript write that fails at the end still prints the answer and the cost",
  { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const dir = tmpDir();
  const sessions = path.join(dir, "sessions");
  fs.mkdirSync(sessions);
  const srv = await startServer((model, body) => {
    // The folder becomes read-only while the chairman is working.
    if (isChairman(body)) fs.chmodSync(sessions, 0o500);
    return null;
  });
  const r = await run(["q"], { LLM_COUNCIL_DIR: dir, LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k", ...TWO });
  await srv.close();
  if (fs.existsSync(sessions)) fs.chmodSync(sessions, 0o700);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /FINAL SYNTHESIS/);
  assert.match(r.stdout, /Cost: US\$ 0\.0500/);
  assert.match(r.stdout, /Transcript not saved:/);
});

test("a chairman answer cut off by the token limit is flagged", async () => {
  const srv = await startServer((model, body) =>
    isChairman(body) ? reply("FINAL SYNTHESIS, half of it", { finish_reason: "length" }) : null);
  const r = await run(["q"], { LLM_COUNCIL_DIR: tmpDir(), LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k", ...TWO });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /cut off at the output token limit/);
  assert.match(r.stderr, /c\/chair.*cut off/);
});

test("a member answer cut off by the token limit is marked before review", async () => {
  const srv = await startServer((model, body) =>
    model === "x-ai/grok-4.5" && !isReview(body) && !isChairman(body)
      ? reply("ANSWER FROM x-ai/grok-4.5 partial", { finish_reason: "length" }) : null);
  const r = await run(["q"], { LLM_COUNCIL_DIR: tmpDir(), LLM_COUNCIL_API_URL: srv.url, OPENROUTER_API_KEY: "k", ...TWO });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  const review = srv.requests.find(q => isReview(q.body));
  assert.match(review.body.messages[1].content, /partial\n\n\[This answer was cut off at the output token limit\.\]/);
  assert.match(r.stderr, /x-ai\/grok-4\.5.*cut off/);
});
