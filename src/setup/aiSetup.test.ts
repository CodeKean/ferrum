// What the model is allowed to change, and what the user is shown before it changes.
//
// These do not call a model. They test the two things that hold whether or not the model behaves:
// the settings it cannot reach, and the summary the user reads before agreeing. Both of those are
// pure functions, and both of them are what makes it safe to let a language model configure a column
// from a documentation page written by a stranger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { safeHttp, diff, resolveSend, resolveLink, resolveWaterfall, zipSteps, PROPOSABLE_KINDS } from "./aiSetup.ts";
import { DEFAULT_HTTP, normalizeHttpConfig } from "../http/httpColumn.ts";
import { COLUMN_KINDS, type Column } from "../types.ts";

const column = (over: Partial<Column> = {}): Column =>
  ({
    id: "1", sheetId: "s", name: "Industry", key: "industry", position: 0,
    kind: "static", valueType: "text", promptVersion: 1, model: "auto",
    maxTurns: 4, timeoutMs: 60_000, maxBudgetUsd: 0.05, allowedTools: [],
    ...over,
  }) as Column;

test("the model cannot turn on private addresses", () => {
  // The single most dangerous setting in the product: it decides whether a request can reach the
  // machine this engine runs on, which holds the user's provider keys. The proposal comes from a
  // model that has just read a web page, so this is not trusted to be absent — it is overwritten.
  const current = normalizeHttpConfig({ ...DEFAULT_HTTP, url: "https://api.example.com", allowPrivate: false });
  const out = safeHttp({ method: "GET", url: "http://127.0.0.1:9000/admin", allowPrivate: true }, current);
  assert.equal(out.allowPrivate, false);

  // And it cannot turn it OFF either — the user's own choice survives the proposal untouched.
  const allowed = normalizeHttpConfig({ ...DEFAULT_HTTP, url: "http://localhost:1234/x", allowPrivate: true });
  assert.equal(safeHttp({ method: "GET", url: "http://localhost:1234/y", allowPrivate: false }, allowed).allowPrivate, true);
});

test("the model configures WHAT to call, not how hard to retry it", () => {
  // Retries and timeouts multiply against the row count, so they are the user's spend decision. A
  // proposal that quietly set maxRetries to 5 would triple the bill of every column it touched.
  const current = normalizeHttpConfig({
    ...DEFAULT_HTTP, url: "https://a", maxRetries: 0, retryOnFailure: false, timeoutMs: 5000, followRedirects: false,
  });
  const out = safeHttp(
    { method: "POST", url: "https://b", maxRetries: 5, retryOnFailure: true, timeoutMs: 120_000, followRedirects: true },
    current,
  );
  assert.equal(out.maxRetries, 0);
  assert.equal(out.retryOnFailure, false);
  assert.equal(out.timeoutMs, 5000);
  assert.equal(out.followRedirects, false);
  // But what it IS allowed to change came through.
  assert.equal(out.method, "POST");
  assert.equal(out.url, "https://b");
});

test("a proposal that changes nothing shows nothing", () => {
  // An "apply" button over an empty list is how a user learns to press it without reading. The
  // summary has to be honest about a no-op.
  const c = column({ kind: "ai", valueType: "text", prompt: "Say the industry" });
  assert.deepEqual(diff(c, { kind: "ai", valueType: "text", prompt: "Say the industry" }), []);
});

test("every changed field is named with its before and after", () => {
  const c = column({ kind: "static", valueType: "text" });
  const changes = diff(c, {
    kind: "http",
    valueType: "url",
    http: normalizeHttpConfig({
      ...DEFAULT_HTTP,
      method: "GET",
      url: "https://api.example.com/lookup",
      query: [{ name: "domain", value: "{{Website}}" }],
      headers: [{ name: "Authorization", value: "Bearer YOUR_KEY" }],
      responsePath: "data.industry",
    }),
  });

  const byField = new Map(changes.map((ch) => [ch.field, ch]));
  assert.equal(byField.get("kind")?.before, "Typed in");
  assert.equal(byField.get("kind")?.after, "Call an API");
  assert.equal(byField.get("valueType")?.after, "url");
  assert.equal(byField.get("http.url")?.before, "none");
  assert.equal(byField.get("http.url")?.after, "https://api.example.com/lookup");
  // Named, not counted alone: "1 header" tells you nothing about whether it is the right header.
  assert.match(byField.get("http.headers")?.after ?? "", /Authorization/);
  assert.match(byField.get("http.query")?.after ?? "", /domain/);
  assert.equal(byField.get("http.responsePath")?.before, "the whole reply");
});

// ─────────────────────────────────────────────────────────── what may be proposed at all

test("every runnable column mode is proposable, so a feature cannot go missing by omission", () => {
  // The regression this exists for: the list of modes was written out by hand, three times — twice
  // in this module and once in the assistant. `send` was added to the product and to none of them,
  // so the largest feature in the app was invisible to every model-facing surface. Nobody could ask
  // for it, nothing ever proposed it, and nothing said why. Derived from COLUMN_KINDS, a kind added
  // later is proposable the day it exists.
  assert.ok(PROPOSABLE_KINDS.includes("send"), "send is a real, runnable mode and must be proposable");
  for (const k of COLUMN_KINDS) {
    if (k === "mcp") continue;
    assert.ok(PROPOSABLE_KINDS.includes(k), `${k} exists in the product but cannot be proposed`);
  }
});

test("mcp is excluded on purpose, because the assistant cannot see the connected apps", () => {
  // The old reason — the executor refused the lane outright — stopped being true when the lane was
  // built, and this test kept passing while its own name became false. The reason now: a working MCP
  // column names a registered app, one of its tools and that tool's arguments, none of which is in
  // the evidence the assistant is handed. It could only guess, and a proposal naming an app the
  // workspace does not have reads as though it were checked.
  assert.ok(!PROPOSABLE_KINDS.includes("mcp" as never));
});

// ─────────────────────────────────────────────────────────── send: names in, ids out

const siblings = [
  { id: "here", name: "Leads", columns: [] },
  { id: "there", name: "Contacted", columns: [{ id: 90, name: "Company" }, { id: 91, name: "Email" }] },
];
const hereCols = [
  { id: "10", name: "Company" } as Column,
  { id: "11", name: "Work email" } as Column,
];

test("a send proposal is resolved against the real workspace, never trusted as ids", () => {
  const out = resolveSend(
    { targetTable: "contacted", mapping: [{ target: "Company", from: "Company" }, { target: "Email", from: "Work email" }] },
    siblings, hereCols, "here",
  );
  assert.equal(out.missing.length, 0);
  assert.equal(out.send?.targetSheetId, "there");
  // Matched case-insensitively — "contacted" and "Contacted" are the same table to everyone except
  // a string comparison.
  assert.deepEqual(out.send?.mapping, { "90": 10, "91": 11 });
});

test("a table that does not exist becomes a sentence, not a send pointed at nothing", () => {
  const out = resolveSend({ targetTable: "Ghosts", mapping: [{ target: "Company", from: "Company" }] }, siblings, hereCols, "here");
  assert.equal(out.send, undefined);
  assert.match(out.missing[0] ?? "", /no table called "Ghosts"/);
});

test("a mapping says WHICH end is wrong, because the fix is in a different place", () => {
  const out = resolveSend(
    { targetTable: "Contacted", mapping: [{ target: "Company", from: "Nonexistent" }, { target: "Nope", from: "Company" }] },
    siblings, hereCols, "here",
  );
  assert.ok(out.missing.some((m) => /This table has no column called "Nonexistent"/.test(m)));
  assert.ok(out.missing.some((m) => /"Contacted" has no column called "Nope"/.test(m)));
});

test("without a column to match on, a send says it inserts — it never claims to update", () => {
  // "upsert" with no key is a lie the Send screen would then repeat: with nothing to compare against,
  // every policy inserts, and the destination grows by the full row count on every run.
  const noKey = resolveSend({ targetTable: "Contacted", mapping: [{ target: "Company", from: "Company" }] }, siblings, hereCols, "here");
  assert.equal(noKey.send?.onConflict, "insert");

  const withKey = resolveSend(
    { targetTable: "Contacted", mapping: [{ target: "Company", from: "Company" }], matchOn: "Company" },
    siblings, hereCols, "here",
  );
  assert.equal(withKey.send?.onConflict, "upsert");
  assert.equal(withKey.send?.keyColumnId, 10);
});

test("the send summary describes the consequence, not the setting name", () => {
  // "insert" means nothing to the person deciding whether to press Apply. What they need to know is
  // what happens when they run it twice.
  const out = resolveSend({ targetTable: "Contacted", mapping: [{ target: "Company", from: "Company" }] }, siblings, hereCols, "here");
  const changes = diff(column({ kind: "static" }), { kind: "send", send: out.send });
  const byField = new Map(changes.map((c) => [c.field, c]));
  assert.equal(byField.get("send.target")?.after, '"Contacted"');
  assert.equal(byField.get("send.onConflict")?.after, "adds the rows again");
  assert.equal(byField.get("kind")?.after, "Send rows to another table");
});

// ─────────────────────────────────────────────────────────── link and waterfall proposals
//
// The same boundary the send tests pin, on the two areas added last: the model names things, and
// THIS code decides whether those names exist. A lookup wired to the wrong column does not fail —
// it fills in, with the wrong values, which is why nothing here may be taken on trust.

test("a link proposal is resolved against the real workspace, never trusted as ids", () => {
  const out = resolveLink(
    { table: "contacted", matchHere: "Company", matchThere: "Company", bringBack: "Email" },
    siblings, hereCols, "here", false,
  );
  assert.equal(out.missing.length, 0);
  assert.equal(out.link?.toSheetId, "there");
  assert.equal(out.link?.fromColumnId, 10);
  assert.equal(out.link?.toColumnId, 90);
  assert.equal(out.link?.bringBackColumnId, 91);
  // The default that makes a real list match: acme.com, ACME.com and https://www.Acme.com/ are the
  // same company, and an exact join over those matches almost nothing while reporting "not found".
  assert.equal(out.link?.matchMode, "normalized");
});

test("a link says WHICH side is missing a column, because the fix is in a different table", () => {
  const out = resolveLink(
    { table: "Contacted", matchHere: "Nonexistent", matchThere: "Nope", bringBack: "Email" },
    siblings, hereCols, "here", false,
  );
  assert.equal(out.link, undefined);
  assert.ok(out.missing.some((m) => /This table has no column called "Nonexistent"/.test(m)));
  assert.ok(out.missing.some((m) => /"Contacted" has no column called "Nope"/.test(m)));
});

test("a lookup with nothing to bring back is refused, not saved half-built", () => {
  // A lookup that saves cleanly and brings nothing across runs, writes blanks, and reads as
  // "nothing matched" — which sends the user to check their data instead of their configuration.
  const out = resolveLink({ table: "Contacted", matchHere: "Company", matchThere: "Company" }, siblings, hereCols, "here", false);
  assert.equal(out.link, undefined);
  assert.match(out.missing[0] ?? "", /Which value to bring across/);
});

test("a rollup needs no field to bring back, and falls back to counting", () => {
  const out = resolveLink(
    { table: "Contacted", matchHere: "Company", matchThere: "Company", rollup: "nonsense" },
    siblings, hereCols, "here", true,
  );
  assert.equal(out.link?.rollup, "count", "counting is the one rollup meaningful whatever the column holds");
  assert.ok(out.missing.some((m) => /counts the matching rows instead/.test(m)));
});

test("a fuzzy match warns, because it is the setting that pairs the wrong rows", () => {
  const out = resolveLink(
    { table: "Contacted", matchHere: "Company", matchThere: "Company", bringBack: "Email", matchMode: "fuzzy" },
    siblings, hereCols, "here", false,
  );
  assert.equal(out.link?.matchMode, "fuzzy");
  assert.ok(out.missing.some((m) => /pair the wrong rows/.test(m)));
});

test("a step's stop rule that will not compile becomes a safe one, and says so", () => {
  // A pattern that cannot compile never accepts anything, so every row would fall through every paid
  // step behind it — the most expensive way for a waterfall to fail, and silent.
  const out = resolveWaterfall([
    { name: "Guess", kind: "script", why: "free", accept: { kind: "matches", pattern: "([" } },
  ]);
  assert.equal(out.steps[0]?.accept.kind, "non_empty");
  assert.ok(out.missing.some((m) => /not a usable pattern/.test(m)));
});

test("a proposed http step says it still needs its provider filling in", () => {
  // A model writing a provider's URL from memory produces a request that looks right and 404s on
  // every row. The order is what it is good at; the address is not.
  const out = resolveWaterfall([
    { name: "Prospeo", kind: "http", why: "cheap", accept: { kind: "non_empty" } },
  ]);
  assert.equal(out.steps.length, 1);
  assert.ok(out.missing.some((m) => /needs the provider's address and key/.test(m)));
});

test("a step of a kind this build does not have is dropped, not guessed at", () => {
  const out = resolveWaterfall([
    { name: "Real", kind: "ai", why: "", accept: { kind: "non_empty" } },
    { name: "Fake", kind: "carrier-pigeon", why: "", accept: { kind: "non_empty" } },
  ]);
  assert.deepEqual(out.steps.map((s) => s.name), ["Real"]);
});

test("a confidence rule is only kept on the lanes that produce a confidence", () => {
  // A script does not grade itself, so a confidence rule on one would never accept and the step
  // would be dead weight in the order.
  const out = resolveWaterfall([
    { name: "Rule", kind: "script", why: "", accept: { kind: "confidence", min: "high" } },
    { name: "Model", kind: "ai", why: "", accept: { kind: "confidence", min: "high" } },
  ]);
  assert.equal(out.steps[0]?.accept.kind, "non_empty");
  assert.equal(out.steps[1]?.accept.kind, "confidence");
});

test("a column named with the app's own slash notation still resolves", () => {
  // Everywhere else in Ferrum a column is written "/Domain", so that is the form the model reaches
  // for — and a bare name comparison rejected it as "This table has no column called /Domain". The
  // user reads that as the model getting the name wrong, when only the notation differed. Seen on
  // the live free model, on the first link proposal it produced.
  const out = resolveLink(
    { table: "Contacted", matchHere: "/Company", matchThere: "/Company", bringBack: "/Email" },
    siblings, hereCols, "here", false,
  );
  assert.equal(out.missing.length, 0);
  assert.equal(out.link?.fromColumnId, 10);
  assert.equal(out.link?.bringBackColumnId, 91);
});

test("the same notation works for a send, which had the identical latent bug", () => {
  const out = resolveSend(
    { targetTable: "Contacted", mapping: [{ target: "/Email", from: "/Work email" }] },
    siblings, hereCols, "here",
  );
  assert.equal(out.missing.length, 0);
  assert.deepEqual(out.send?.mapping, { "91": 11 });
});

test("a link across workbooks is refused at PROPOSAL time, not on Apply", () => {
  // The list of tables the model sees is the whole workspace, because a send column can write into
  // any of them. A link cannot — createRelation refuses two tables in different workbooks. Without
  // this check the panel proposed a tidy lookup and Apply failed with "Both tables have to be in the
  // same workbook": a proposal that looks applicable and is not. Reproduced against the live engine.
  const far = [
    { id: "here", name: "Leads", workbookId: "wb-1", columns: [] },
    { id: "there", name: "Contacted", workbookId: "wb-2", columns: [{ id: 90, name: "Company" }, { id: 91, name: "Email" }] },
  ];
  const out = resolveLink(
    { table: "Contacted", matchHere: "Company", matchThere: "Company", bringBack: "Email" },
    far, hereCols, "here", false, "wb-1",
  );
  assert.equal(out.link, undefined);
  assert.match(out.missing[0] ?? "", /different workbook/);
});

test("a link inside one workbook still resolves", () => {
  const same = [
    { id: "here", name: "Leads", workbookId: "wb-1", columns: [] },
    { id: "there", name: "Contacted", workbookId: "wb-1", columns: [{ id: 90, name: "Company" }, { id: 91, name: "Email" }] },
  ];
  const out = resolveLink(
    { table: "Contacted", matchHere: "Company", matchThere: "Company", bringBack: "Email" },
    same, hereCols, "here", false, "wb-1",
  );
  assert.equal(out.missing.length, 0);
  assert.equal(out.link?.toSheetId, "there");
});

test("the parallel-array step form zips back into steps", () => {
  // The array-of-objects form produced NO tool call at all from the free design model. Arrays of
  // plain strings it fills. A ragged set is padded rather than thrown away.
  const zipped = zipSteps({
    stepNames: ["Guess", "Prospeo", "Ask a model"],
    stepKinds: ["script", "http", "ai"],
    stepStops: ["email", "email"],
    stepWhys: ["free"],
  });
  const out = resolveWaterfall(zipped);
  assert.deepEqual(out.steps.map((s) => s.name), ["Guess", "Prospeo", "Ask a model"]);
  assert.equal(out.steps[0]?.accept.kind, "matches", "a named shape becomes a real pattern");
  assert.equal(out.steps[2]?.accept.kind, "non_empty", "a missing stop falls back rather than dropping the step");
});

test("the stop shapes are real patterns, so a stop rule cannot silently never match", () => {
  // A stop rule that never matches sends every row through every paid step behind it. These are
  // written once and checked here rather than invented per proposal by a model.
  const out = resolveWaterfall(zipSteps({
    stepNames: ["A", "B", "C"], stepKinds: ["ai", "ai", "ai"], stepStops: ["email", "phone", "domain"],
  }));
  const pat = (i: number) => new RegExp((out.steps[i]!.accept as { pattern: string }).pattern, "i");
  assert.ok(pat(0).test("sam@acme.com"));
  assert.ok(!pat(0).test("not found"));
  assert.ok(pat(1).test("+44 7700 900123"));
  assert.ok(pat(2).test("acme.com"));
});
