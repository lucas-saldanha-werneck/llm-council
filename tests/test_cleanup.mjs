// Runs the whole suite in a child with its own temp folder, then checks nothing was left behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("the test suite leaves no temp folder and no process behind", { timeout: 240000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suite-cleanup-"));
  const pidlog = path.join(tmp, "pids.txt");
  const sandbox = path.join(tmp, "t");
  fs.mkdirSync(sandbox);
  try {
    const env = { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox, LLM_COUNCIL_TEST_PIDLOG: pidlog };
    delete env.NODE_TEST_CONTEXT; // else the child runs as a nested test and does nothing
    const r = spawnSync(process.execPath, ["--test", path.join(ROOT, "tests", "test_council.mjs")], {
      env, encoding: "utf8", timeout: 200000,
    });
    assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr.slice(-1000));
    assert.deepEqual(fs.readdirSync(sandbox), [], "temp folders left behind");
    const pids = fs.readFileSync(pidlog, "utf8").split("\n").filter(Boolean).map(Number);
    assert.ok(pids.length > 0, "the suite started no fake Codex, so this check proves nothing");
    for (const pid of pids) assert.equal(alive(pid), false, `pid ${pid} is still alive`);
    if (process.platform !== "win32") {
      let out = "";
      try { out = execFileSync("pgrep", ["-f", sandbox], { encoding: "utf8" }); } catch { /* no match */ }
      assert.equal(out.trim(), "", "a process still runs from the suite's temp folder");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
