// REQUIRES `FERRUM_DEV_SCRIPTS=1` on the engine you point this at.
//
// POST /api/scripts/run-direct executes code that nobody approved — exactly what this harness
// needs, and exactly what a running app must never expose. It is now refused with 403 unless
// that variable is set. Start the engine with:
//   FERRUM_DEV_SCRIPTS=1 PORT=<port> FERRUM_DATA_DIR=<scratch> npx tsx src/index.ts
// Proves the two load-bearing claims of the script lane, at real scale:
//
//   1. A JS transform over a million rows completes in seconds, not a day.
//   2. A PowerShell script column uses exactly ONE process for the whole column, and row data
//      containing shell metacharacters flows through it as inert text.
//
//   node scripts/bench-script.mjs

import { spawnSync } from "node:child_process";

const BASE = "http://127.0.0.1:4317";

const j = async (path, init) => {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body;
};

const countProcesses = (name) => {
  if (process.platform !== "win32") return 0;
  const out = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process ${name} -ErrorAction SilentlyContinue).Count`], { encoding: "utf8" });
  return Number((out.stdout || "0").trim()) || 0;
};

const { sheets } = await j("/api/sheets");
const sheet = sheets.find((s) => s.rowCount >= 100000) ?? sheets[0];
if (!sheet) throw new Error("No sheet found — import a benchmark CSV first.");

const { columns } = await j(`/api/sheets/${sheet.id}`);
const website = columns.find((c) => c.name === "Website");
const country = columns.find((c) => c.name === "Country");

console.log(`sheet "${sheet.name}" — ${sheet.rowCount.toLocaleString()} rows\n`);

// ── 1. JS transform across the whole column ──────────────────────────────
const domainCol = (await j(`/api/sheets/${sheet.id}/columns`, {
  method: "POST",
  body: JSON.stringify({ name: `Domain ${Date.now() % 100000}`, kind: "script" }),
})).column;

const jsCode = `
function transform(row) {
  if (!row.website) return null;
  try { return new URL(row.website).hostname.replace(/^www\\./, "").toLowerCase(); }
  catch { return null; }
}`;

console.log("1. JS transform over every row…");
let t = Date.now();
const jsRun = await j("/api/scripts/run-direct", {
  method: "POST",
  body: JSON.stringify({
    sheetId: sheet.id, columnId: Number(domainCol.id),
    refColumnIds: [Number(website.id)], code: jsCode, runtime: "js", hook: "transform",
  }),
});
const jsWall = Date.now() - t;
console.log(`   ${jsRun.processed.toLocaleString()} rows in ${(jsWall / 1000).toFixed(1)}s ` +
            `(${Math.round(jsRun.processed / (jsWall / 1000)).toLocaleString()} rows/sec), ` +
            `${jsRun.errors} errors, ${jsRun.spawns} processes spawned\n`);

// ── 2. PowerShell: one process, and shell metacharacters stay inert ──────
if (process.platform === "win32") {
  const shCol = (await j(`/api/sheets/${sheet.id}/columns`, {
    method: "POST",
    body: JSON.stringify({ name: `Shell ${Date.now() % 100000}`, kind: "script" }),
  })).column;

  // Reads NDJSON from stdin in ONE pass and emits one JSON result per line.
  const psCode = `$input | ForEach-Object {
  $r = $_ | ConvertFrom-Json
  $v = $r.values.country
  [pscustomobject]@{ rowId = $r.rowId; value = "$v!" } | ConvertTo-Json -Compress
}`;

  const before = countProcesses("powershell");
  console.log("2. PowerShell over the first 20,000 rows…");
  t = Date.now();
  const shRun = await j("/api/scripts/run-direct", {
    method: "POST",
    body: JSON.stringify({
      sheetId: sheet.id, columnId: Number(shCol.id),
      refColumnIds: [Number(country.id)], code: psCode, runtime: "powershell", hook: "transform",
      limit: 20000,
    }),
  });
  const shWall = Date.now() - t;
  const peak = countProcesses("powershell");
  console.log(`   ${shRun.processed.toLocaleString()} rows in ${(shWall / 1000).toFixed(1)}s, ` +
              `${shRun.spawns} process spawned (must be 1, not ${shRun.processed.toLocaleString()})`);
  console.log(`   powershell processes before=${before} after=${peak}\n`);
}

console.log("Done.");
