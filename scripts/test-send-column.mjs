// End-to-end: "send to another table" as a COLUMN, through the real HTTP API.
//
//   node scripts/test-send-column.mjs
//
// What this has to prove, because each of these is a way the feature could look like it works and
// not: the column runs like any other column, it is idempotent across runs, a run CONDITION gates
// it (which is the whole reason it became a column rather than a button), and each source row's own
// cell says what happened to it.

const BASE = "http://127.0.0.1:4317";

const j = async (path, init) => {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json();
  if (body.error) throw new Error(`${path}: ${body.error}`);
  return body;
};

const stamp = Date.now() % 100000;
const fail = [];
const check = (ok, what) => { console.log(`   ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) fail.push(what); };

// ── a source table with three rows ───────────────────────────────────────
const src = (await j("/api/sheets", { method: "POST", body: JSON.stringify({ name: `Leads ${stamp}` }) })).sheet;
const cName = (await j(`/api/sheets/${src.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Company" }) })).column;
const cCountry = (await j(`/api/sheets/${src.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Country" }) })).column;

const { writeFileSync } = await import("node:fs");
const csvPath = process.cwd().replace(/\\/g, "/") + `/.devdata/send-${stamp}.csv`;
writeFileSync(csvPath, "Company,Country\nAcme,US\nBeta,UK\nGamma,US\n", "utf8");
await j(`/api/sheets/${src.id}/import`, { method: "POST", body: JSON.stringify({ path: csvPath }) });

// ── a destination ────────────────────────────────────────────────────────
const dst = (await j("/api/sheets", { method: "POST", body: JSON.stringify({ name: `CRM ${stamp}` }) })).sheet;
const dName = (await j(`/api/sheets/${dst.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Company" }) })).column;
const dCountry = (await j(`/api/sheets/${dst.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Country" }) })).column;

// ── the send column ──────────────────────────────────────────────────────
const send = (await j(`/api/sheets/${src.id}/columns`, {
  method: "POST", body: JSON.stringify({ name: "Send to CRM", kind: "send" }),
})).column;

const sendCfg = {
  targetSheetId: dst.id,
  method: "row",
  mapping: {
    [dName.id]: { from: "row", columnId: Number(cName.id) },
    [dCountry.id]: { from: "row", columnId: Number(cCountry.id) },
  },
  keySource: { from: "row", columnId: Number(cName.id) },
  onConflict: "upsert",
  withBackRef: true,
  cap: 50,
};
await j(`/api/columns/${send.id}`, { method: "PATCH", body: JSON.stringify({ send: sendCfg }) });

console.log("1. a send column, configured:");
const stored = (await j(`/api/columns/${send.id}`)).column;
check(stored.kind === "send", "the column runs on the send lane");
check(!!stored.sendConfig?.targetSheetId, "its destination came back from the engine");

// The engine refuses a table sending into itself — that would append to the rows it is reading.
let refused = false;
try {
  await j(`/api/columns/${send.id}`, { method: "PATCH", body: JSON.stringify({ send: { ...sendCfg, targetSheetId: src.id } }) });
} catch { refused = true; }
check(refused, "a table cannot be set to send into itself");

// ── 2. the dry run ───────────────────────────────────────────────────────
const plan = await j(`/api/columns/${send.id}/send/preview`, { method: "POST", body: JSON.stringify({}) });
console.log(`\n2. preview: ${plan.inserts} inserts, ${plan.updates} updates, ${plan.skips} skips`);
for (const p of plan.preview) console.log(`     ${p.action}  key=${JSON.stringify(p.key)}  ${JSON.stringify(p.values)}`);
check(plan.inserts === 3, "preview says three new rows");

// ── 3. run it like any other column ──────────────────────────────────────
const runOnce = async (label) => {
  const { run } = await j(`/api/sheets/${src.id}/runs`, {
    method: "POST", body: JSON.stringify({ scope: { columnIds: [Number(send.id)], force: true } }),
  });
  // The send lane is synchronous inside the run, but the run itself is started and then executed —
  // poll rather than assume, the same way the UI does.
  for (let i = 0; i < 60; i++) {
    const r = (await j(`/api/runs/${run.id}`)).run;
    if (r.status === "done" || r.status === "failed" || r.status === "cancelled") return r;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error(`${label}: the run never finished`);
};

await runOnce("first run");
const after1 = (await j(`/api/sheets/${dst.id}`)).sheet.rowCount;
console.log(`\n3. ran the column: destination has ${after1} rows`);
check(after1 === 3, "three rows arrived");

const win = await j(`/api/sheets/${src.id}/rows?offset=0&limit=5`);
const cells = win.rows.map((r) => r.cells[String(send.id)]);
console.log(`   source cells: ${cells.map((c) => JSON.stringify(c?.v)).join(", ")}`);
check(cells.every((c) => c?.v === "sent"), "every source row's own cell says what happened to it");

// ── 4. run it again: must UPDATE, never duplicate ────────────────────────
await runOnce("second run");
const after2 = (await j(`/api/sheets/${dst.id}`)).sheet.rowCount;
console.log(`\n4. ran it again: ${after1} -> ${after2} rows`);
check(after1 === after2, "re-running did not duplicate the destination");

// ── 5. a run condition gates it ──────────────────────────────────────────
//
// The whole reason this is a column rather than a button. A condition is free, runs before anything
// is written, and decides which rows go.
const cond = await j(`/api/columns/${send.id}/scripts`, {
  method: "POST",
  body: JSON.stringify({
    hook: "condition",
    runtime: "js",
    intent: "only US companies",
    code: `function condition(row) { return row.country === 'US'; }`,
  }),
});
await j(`/api/scripts/${cond.script.id}/approve`, { method: "POST", body: JSON.stringify({ hash: cond.script.hash }) });

// A fresh destination, so the count is about the condition and nothing else.
const dst2 = (await j("/api/sheets", { method: "POST", body: JSON.stringify({ name: `CRM US ${stamp}` }) })).sheet;
const d2Name = (await j(`/api/sheets/${dst2.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Company" }) })).column;
await j(`/api/columns/${send.id}`, {
  method: "PATCH",
  body: JSON.stringify({
    send: {
      ...sendCfg,
      targetSheetId: dst2.id,
      mapping: { [d2Name.id]: { from: "row", columnId: Number(cName.id) } },
    },
  }),
});

await runOnce("gated run");
const gated = (await j(`/api/sheets/${dst2.id}`)).sheet.rowCount;
const win2 = await j(`/api/sheets/${src.id}/rows?offset=0&limit=5`);
const statuses = win2.rows.map((r) => r.cells[String(send.id)]?.s);
console.log(`\n5. with a "US only" run condition: ${gated} rows sent`);
console.log(`   source cell statuses: ${statuses.join(", ")}`);
check(gated === 2, "only the two US rows were sent");
check(statuses.filter((s) => s === "skipped").length === 1, "the UK row is marked skipped, not failed");

console.log(`\n${fail.length === 0 ? "PASS" : `FAIL — ${fail.length} check(s) failed`}`);
process.exit(fail.length === 0 ? 0 : 1);
