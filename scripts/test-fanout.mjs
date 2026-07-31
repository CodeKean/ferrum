// End-to-end: a JSON column, expanded into sibling columns, then a list fanned out into rows of
// another table — through the real HTTP API.
//
//   node scripts/test-fanout.mjs

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

// ── a Companies table holding one JSON blob per row ──────────────────────
const companies = (await j("/api/sheets", { method: "POST", body: JSON.stringify({ name: `Companies ${stamp}` }) })).sheet;
const nameCol = (await j(`/api/sheets/${companies.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Company" }) })).column;
const jsonCol = (await j(`/api/sheets/${companies.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Enriched", valueType: "json" }) })).column;

const payloads = [
  { industry: "SaaS", hq: { city: "Austin", country: "US" }, contacts: [
      { name: "Ann Lee", email: "ann@acme.com", title: "VP Sales" },
      { name: "Bob Ray", email: "bob@acme.com", title: "Engineer" }] },
  { industry: "Fintech", hq: { city: "London", country: "UK" }, contacts: [
      { name: "Cy Doe", email: "cy@beta.io", title: "Head of Growth" }] },
  { industry: "Logistics", hq: { city: "Berlin", country: "DE" }, contacts: [] },
];

// Seed via CSV so it takes the same path real data does.
const { writeFileSync } = await import("node:fs");
const csv = "Company,Enriched\n" + payloads.map((p, i) =>
  `"Co ${i}","${JSON.stringify(p).replace(/"/g, '""')}"`).join("\n") + "\n";
const csvPath = process.cwd().replace(/\\/g, "/") + "/.devdata/fanout.csv";
writeFileSync(csvPath, csv, "utf8");
await j(`/api/sheets/${companies.id}/import`, { method: "POST", body: JSON.stringify({ path: csvPath }) });

const cols = (await j(`/api/sheets/${companies.id}`)).columns;
const enriched = cols.find((c) => c.name === "Enriched");

// ── 1. discover the fields inside the JSON ───────────────────────────────
const { fields } = await j(`/api/columns/${enriched.id}/json-fields`);
console.log("1. fields discovered in the JSON column:");
for (const f of fields) {
  console.log(`   ${f.path.padEnd(16)} ${String(f.valueType).padEnd(8)} coverage ${(f.coverage * 100).toFixed(0).padStart(3)}%  e.g. ${JSON.stringify(f.sample)}`);
}
console.log(`   (note: no "contacts[0]..." paths — a LIST belongs in another table, not in columns)\n`);

// ── 2. expand chosen fields into free sibling columns ────────────────────
const expand = await j(`/api/columns/${enriched.id}/expand`, {
  method: "POST",
  body: JSON.stringify({ fields: [{ path: "industry" }, { path: "hq.city" }, { path: "hq.country" }] }),
});
console.log("2. expanded into sibling columns (deterministic — no model call):");
for (const c of expand.created) console.log(`   ${c.name}  <-  ${c.path}`);

const win = await j(`/api/sheets/${companies.id}/rows?offset=0&limit=3`);
const byId = Object.fromEntries((await j(`/api/sheets/${companies.id}`)).columns.map((c) => [c.id, c.name]));
console.log("   values:");
for (const r of win.rows) {
  const vals = expand.created.map((c) => `${byId[String(c.columnId)]}=${JSON.stringify(r.cells[String(c.columnId)]?.v ?? null)}`);
  console.log(`     row ${r.position}: ${vals.join("  ")}`);
}
console.log();

// ── 3. fan the contacts list out into a People table ─────────────────────
const people = (await j("/api/sheets", { method: "POST", body: JSON.stringify({ name: `People ${stamp}` }) })).sheet;
const pName = (await j(`/api/sheets/${people.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Full name" }) })).column;
const pEmail = (await j(`/api/sheets/${people.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Email", valueType: "email" }) })).column;
const pTitle = (await j(`/api/sheets/${people.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Title" }) })).column;

const contactsCol = (await j(`/api/columns/${enriched.id}/expand`, {
  method: "POST", body: JSON.stringify({ fields: [{ path: "contacts", valueType: "array" }] }),
})).created[0];

const fanBody = {
  sourceColumnId: contactsCol.columnId,
  fanOut: "per_item",
  cap: 50,
  scope: {},
  withBackRef: true,
  target: {
    targetSheetId: people.id,
    mapping: { [pName.id]: "name", [pEmail.id]: "email", [pTitle.id]: "title" },
    keyPath: "email",
    onConflict: "upsert",
  },
};

const plan = await j(`/api/sheets/${companies.id}/write-target/plan`, { method: "POST", body: JSON.stringify(fanBody) });
console.log("3. fan-out DRY RUN (nothing written yet):");
console.log(`   ${plan.inserts} inserts, ${plan.updates} updates, ${plan.skips} skips`);
for (const p of plan.preview) console.log(`     ${p.action}  ${JSON.stringify(p.values)}`);

const applied = await j(`/api/sheets/${companies.id}/write-target/apply`, { method: "POST", body: JSON.stringify(fanBody) });
const after1 = (await j(`/api/sheets/${people.id}`)).sheet.rowCount;
console.log(`   applied: ${applied.inserts} inserts -> People now has ${after1} rows`);

// ── 4. re-run it: must UPDATE, never duplicate ───────────────────────────
const again = await j(`/api/sheets/${companies.id}/write-target/apply`, { method: "POST", body: JSON.stringify(fanBody) });
const after2 = (await j(`/api/sheets/${people.id}`)).sheet.rowCount;
console.log(`\n4. re-ran the same fan-out: ${again.inserts} inserts, ${again.updates} updates`);
console.log(`   People rows: ${after1} -> ${after2}  ${after1 === after2 ? "(unchanged — idempotent)" : "*** DUPLICATED ***"}`);

// ── 5. the back-reference ────────────────────────────────────────────────
const pcols = (await j(`/api/sheets/${people.id}`)).columns;
const backRef = pcols.find((c) => /row$/.test(c.name));
const pwin = await j(`/api/sheets/${people.id}/rows?offset=0&limit=5`);
console.log(`\n5. back-reference column "${backRef?.name}":`);
for (const r of pwin.rows) {
  console.log(`   ${r.cells[String(pEmail.id)]?.v}  <- source row ${r.cells[String(backRef?.id)]?.v}`);
}

// ── 6. send whole ROWS to another table ──────────────────────────────────
//
// The other half of "send table data", and the one that had no path through the app at all: no
// source column, no list, just these rows into that table. It has to be idempotent on a re-run the
// same way the fan-out is — and there the match key cannot live inside an item, because there is no
// item. It comes off a COLUMN of the row.
const mirror = (await j("/api/sheets", { method: "POST", body: JSON.stringify({ name: `Mirror ${stamp}` }) })).sheet;
const mName = (await j(`/api/sheets/${mirror.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Company" }) })).column;
const mIndustry = (await j(`/api/sheets/${mirror.id}/columns`, { method: "POST", body: JSON.stringify({ name: "Industry" }) })).column;

const industryCol = (await j(`/api/sheets/${companies.id}`)).columns.find((c) => c.name === "Industry");

const rowBody = {
  fanOut: "row",
  scope: {},
  withBackRef: true,
  target: {
    targetSheetId: mirror.id,
    mapping: {
      [mName.id]: { from: "row", columnId: Number(nameCol.id) },
      [mIndustry.id]: { from: "row", columnId: Number(industryCol.id) },
    },
    keySource: { from: "row", columnId: Number(nameCol.id) },
    onConflict: "upsert",
  },
};

const rowPlan = await j(`/api/sheets/${companies.id}/write-target/plan`, { method: "POST", body: JSON.stringify(rowBody) });
console.log(`\n6. send whole rows — DRY RUN: ${rowPlan.inserts} inserts, ${rowPlan.updates} updates`);
for (const p of rowPlan.preview) console.log(`     ${p.action}  key=${JSON.stringify(p.key)}  ${JSON.stringify(p.values)}`);

const rowApplied = await j(`/api/sheets/${companies.id}/write-target/apply`, { method: "POST", body: JSON.stringify(rowBody) });
const m1 = (await j(`/api/sheets/${mirror.id}`)).sheet.rowCount;
const rowAgain = await j(`/api/sheets/${companies.id}/write-target/apply`, { method: "POST", body: JSON.stringify(rowBody) });
const m2 = (await j(`/api/sheets/${mirror.id}`)).sheet.rowCount;
console.log(`   applied: ${rowApplied.inserts} inserts -> Mirror has ${m1} rows`);
console.log(`   re-ran:  ${rowAgain.inserts} inserts, ${rowAgain.updates} updates -> ${m2} rows  ${m1 === m2 ? "(unchanged — idempotent)" : "*** DUPLICATED ***"}`);

// The values actually landed, rather than three rows of nulls with the right count.
const mwin = await j(`/api/sheets/${mirror.id}/rows?offset=0&limit=5`);
const filled = mwin.rows.filter((r) => r.cells[String(mName.id)]?.v && r.cells[String(mIndustry.id)]?.v).length;
console.log(`   rows carrying both mapped values: ${filled} of ${mwin.rows.length}`);

const rowOk =
  m1 === m2 &&
  rowPlan.inserts === rowApplied.inserts &&
  rowApplied.inserts === payloads.length &&
  rowAgain.updates === payloads.length &&
  filled === payloads.length;

const ok = after1 === after2 && plan.inserts === applied.inserts && rowOk;
console.log(`\n${ok ? "PASS" : "FAIL"} — preview matched the write, and neither re-run duplicated.`);
process.exit(ok ? 0 : 1);
