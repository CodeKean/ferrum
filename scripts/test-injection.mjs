// REQUIRES `FERRUM_DEV_SCRIPTS=1` on the engine you point this at.
//
// POST /api/scripts/run-direct executes code that nobody approved — exactly what this harness
// needs, and exactly what a running app must never expose. It is now refused with 403 unless
// that variable is set. Start the engine with:
//   FERRUM_DEV_SCRIPTS=1 PORT=<port> FERRUM_DATA_DIR=<scratch> npx tsx src/index.ts
// Proves that row data reaching a SHELL script is inert.
//
// The generated script is trusted once a human approves it. The row data flowing through it never
// is — it arrives from a CSV a vendor sent, or from a web page an agent scraped. If values were
// interpolated into the command line, a cell reading `; Remove-Item -Recurse C:\` would execute.
// They are written to the child's stdin as NDJSON instead, so the shell never parses them.
//
//   node scripts/test-injection.mjs

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

// Each of these is a real shell metacharacter payload for the runtime under test.
const PAYLOADS = [
  "; Remove-Item -Recurse C:\\",
  "$(whoami)",
  "`whoami`",
  "&& calc.exe",
  "| Out-File C:\\pwned.txt",
  "'; DROP TABLE cells; --",
  "$env:ANTHROPIC_API_KEY",
  "normal value",
];

const sheet = (await j("/api/sheets", { method: "POST", body: JSON.stringify({ name: `Injection ${Date.now() % 100000}` }) })).sheet;
const payloadCol = (await j(`/api/sheets/${sheet.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Payload" }) })).column;
const outCol = (await j(`/api/sheets/${sheet.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Echoed", kind: "script" }) })).column;

// Seed the rows by writing cells directly.
const { rows } = await j(`/api/sheets/${sheet.id}/rows?offset=0&limit=1`);
console.log(`seeding ${PAYLOADS.length} rows with shell metacharacter payloads…`);

// Import them via CSV so they take the same path real data takes.
const { writeFileSync } = await import("node:fs");
const csvPath = process.cwd() + "/.devdata/injection.csv";
writeFileSync(csvPath, "Payload\n" + PAYLOADS.map((p) => `"${p.replace(/"/g, '""')}"`).join("\n") + "\n", "utf8");
await j(`/api/sheets/${sheet.id}/import`, { method: "POST", body: JSON.stringify({ path: csvPath.replace(/\\/g, "/") }) });

// The script simply echoes the value back. If any payload were being interpreted rather than passed
// as data, the echoed value would differ from the input — or the shell would act on it.
const psCode = `$input | ForEach-Object {
  $r = $_ | ConvertFrom-Json
  [pscustomobject]@{ rowId = $r.rowId; value = $r.values.payload } | ConvertTo-Json -Compress
}`;

const { columns } = await j(`/api/sheets/${sheet.id}`);
const pc = columns.find((c) => c.name === "Payload");
const oc = columns.find((c) => c.name === "Echoed");

const run = await j("/api/scripts/run-direct", {
  method: "POST",
  body: JSON.stringify({
    sheetId: sheet.id, columnId: Number(oc.id), refColumnIds: [Number(pc.id)],
    code: psCode, runtime: "powershell", hook: "transform",
  }),
});

const win = await j(`/api/sheets/${sheet.id}/rows?offset=0&limit=50`);
console.log(`\nran ${run.processed} rows in ${run.spawns} process\n`);

let pass = 0, fail = 0;
for (const row of win.rows) {
  const inVal = row.cells[String(pc.id)]?.v ?? "";
  const outVal = row.cells[String(oc.id)]?.v ?? "";
  const ok = inVal === outVal;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  in=${JSON.stringify(inVal)}  out=${JSON.stringify(outVal)}`);
}

// A payload that executed would have produced a username, a file, or an empty value — never an
// exact echo of itself.
const { existsSync } = await import("node:fs");
const sideEffect = existsSync("C:\\pwned.txt");

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`side-effect file created: ${sideEffect ? "YES — INJECTION SUCCEEDED" : "no"}`);
process.exit(fail === 0 && !sideEffect ? 0 : 1);
