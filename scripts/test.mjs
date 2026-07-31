// Test runner.
//
// Every test FILE gets its own fresh data directory, and each is run in its own process.
//
// Two separate problems, one solution. Leftover state from a previous run made the tests
// order-dependent — that showed up once as four failures that passed individually and were nothing
// but a stale DB. And `node --test` runs FILES in parallel, so several processes were opening the
// same SQLite database at once; past three files that started failing intermittently with
// `database is locked`, including errcode 517 (SQLITE_BUSY_SNAPSHOT), which busy_timeout does not
// retry by design. Different tests failed on every run, which is the signature of contention rather
// than of a bug in the code under test.
//
// Isolating the database per file removes both classes at once, and the files still run in parallel.

import { rmSync, mkdtempSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolve the files here rather than passing a glob: spawn runs without a shell, so a glob would be
// handed through as a literal string and silently match nothing — which looks like "all tests
// passed" rather than "no tests ran".
function findTests(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...findTests(p));
    else if (entry.name.endsWith(".test.ts")) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

// Both roots. The browser code has logic worth testing too — the cost model the mode picker gives
// its advice from is pure arithmetic with no DOM in it, and a runner that only looked at src/ was
// reporting "all tests passed" while never running a line of it.
const files = [...findTests("src"), ...findTests("web/src")];
if (files.length === 0) {
  console.error("No test files found under src/ or web/src/ — refusing to report success.");
  process.exit(1);
}
console.log(`running ${files.length} test file(s), each against its own database\n`);

// Spawn node directly rather than npx: on Windows `npx.cmd` is a batch file, which cannot be
// launched with shell:false — it fails silently, producing no output and an exit code that looks
// like a pass. Using process.execPath with the tsx loader avoids the shell entirely.
function runFile(file) {
  const dir = mkdtempSync(join(tmpdir(), "ferrum-test-"));
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", file],
      {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: { ...process.env, CLAYCODE_DATA_DIR: dir.replace(/\\/g, "/") },
      },
    );
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (err) => resolve({ file, dir, code: 1, out: `failed to launch: ${err.message}\n` }));
    child.on("close", (code) => resolve({ file, dir, code: code ?? 1, out }));
  });
}

const results = await Promise.all(files.map(runFile));

let failed = 0;
for (const r of results) {
  // The per-file output is interleaved-free because each child is buffered and printed whole.
  process.stdout.write(r.out);
  if (r.code !== 0) failed++;
  try { rmSync(r.dir, { recursive: true, force: true }); } catch { /* Windows may still hold the WAL */ }
}

console.log(
  failed === 0
    ? `\nall ${files.length} test file(s) passed`
    : `\n${failed} of ${files.length} test file(s) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
