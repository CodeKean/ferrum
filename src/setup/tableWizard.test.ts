// The create-table interview.
//
// Two halves, tested separately for a reason: `parseStep` is where a model's answer becomes
// something this app will act on, and `applyPlan` is where a plan becomes real tables and columns.
// Neither needs a model to be worth testing, and testing them any other way costs money per run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { listColumns, listSheets } from "./../store.ts";
import { getConfig as getDedupe } from "../dedupe.ts";
import { listSources } from "../sources/webhook.ts";
import { applyPlan, parseStep, type TablePlan } from "./tableWizard.ts";

const PLAN: TablePlan = {
  name: "UK PR firms",
  summary: "Agencies to reach out to, enriched with a contact.",
  columns: [
    { name: "Company", kind: "static", valueType: "text" },
    { name: "Domain", kind: "static", valueType: "url" },
    { name: "Industry", kind: "ai", valueType: "text", prompt: "What industry is /Company in?" },
    { name: "Headcount", kind: "http", valueType: "number", http: { method: "GET", url: "https://api.example.com/size" } },
  ],
  source: { kind: "webhook", note: "A Zapier step posts each new firm." },
  destination: { kind: "to_table", toTable: "Outreach", note: "Qualified rows go to the outreach table." },
  dedupeOn: ["Domain", "Company"],
  missing: ["An API key for the headcount lookup."],
};

test("an ask with no questions is refused rather than shown", () => {
  // It would render as a screen with a heading, nothing to answer, and no way forward — the
  // interview simply stops, and nothing on screen says why.
  assert.throws(() => parseStep({ step: "ask", questions: [] }), /asked nothing/i);
  assert.throws(() => parseStep({ step: "ask" }), /asked nothing/i);

  const ok = parseStep({ step: "ask", questions: [{ question: "Where do the rows come from?", why: "It decides the source." }] });
  assert.equal(ok.step, "ask");
  assert.equal(ok.step === "ask" ? ok.questions.length : 0, 1);
});

test("a plan with no columns is refused, and unknown modes degrade instead of failing", () => {
  assert.throws(() => parseStep({ step: "plan", plan: { columns: [] } }), /no columns/i);

  // A typo in a mode name should cost a checkbox, not the whole plan.
  const step = parseStep({
    step: "plan",
    plan: {
      name: "T", summary: "s",
      columns: [{ name: "A", kind: "wizardry", valueType: "unicorn" }],
      source: { kind: "telepathy", note: "" },
      destination: { kind: "smoke signals", note: "" },
    },
  });
  assert.equal(step.step, "plan");
  if (step.step !== "plan") return;
  assert.equal(step.plan.columns[0]!.kind, "static");
  assert.equal(step.plan.columns[0]!.valueType, "text");
  assert.equal(step.plan.source.kind, "manual");
  assert.equal(step.plan.destination.kind, "none");
});

test("applying a plan builds the table, its columns and its dedupe rule", () => {
  const res = applyPlan(PLAN);

  assert.equal(res.sheet.name, "UK PR firms");
  const cols = listColumns(res.sheet.id);
  assert.deepEqual(cols.map((c) => c.name), ["Company", "Domain", "Industry", "Headcount"]);
  assert.equal(cols.find((c) => c.name === "Industry")!.kind, "ai");
  // The reference is STORED as an id. Left as `/Company` the engine sees no reference at all: no
  // dependency, no required-reference skip, and every row asking about the literal text — and it
  // would break the moment someone renamed the column.
  assert.equal(
    cols.find((c) => c.name === "Industry")!.prompt,
    `What industry is {{col:${cols.find((c) => c.name === "Company")!.id}}} in?`,
  );
  assert.equal(cols.find((c) => c.name === "Headcount")!.kind, "http");

  // Dedupe is CONFIGURED but not automatic. Removing rows on arrival is the table owner's decision,
  // not one a generated plan makes on their behalf.
  const dd = getDedupe(res.sheet.id);
  assert.deepEqual(dd.columnIds, [
    Number(cols.find((c) => c.name === "Domain")!.id),
    Number(cols.find((c) => c.name === "Company")!.id),
  ], "in the order the plan gave, because it is a waterfall");
  assert.equal(dd.auto, false);
});

test("the built table knows which columns its prompts and requests read", () => {
  // The conversion to `{{col:N}}` is only half the job: the engine reads dependencies out of
  // `column_deps`, which was written from one place only — saving a generated script. So a wizard
  // table came out with no edges, every column at depth 0, and a run order that was whatever order
  // the columns happened to be enumerated in.
  const res = applyPlan(PLAN);
  const cols = listColumns(res.sheet.id);
  const id = (name: string) => Number(cols.find((c) => c.name === name)!.id);

  // Mapped to plain pairs: the driver returns null-prototype rows, which no deep-equality assertion
  // matches against an object literal.
  const industry = db.prepare("SELECT depends_on, via FROM column_deps WHERE column_id = ?").all(id("Industry")) as any[];
  assert.deepEqual(industry.map((d) => [Number(d.depends_on), String(d.via)]), [[id("Company"), "prompt"]]);
});

test("a webhook source is created when the plan says rows arrive from another tool", () => {
  const res = applyPlan(PLAN);
  const sources = listSources(res.sheet.id);
  assert.equal(sources.length, 1);
  assert.equal(res.webhookToken, sources[0]!.token);
  assert.ok(res.webhookToken!.length >= 32);
});

test("what the plan describes but does not build is reported, not implied", () => {
  // The failure this prevents is the worst kind of silent: a plan that says "qualified rows go to
  // the outreach table", a table that is created, and nothing anywhere doing that — discovered a
  // week later when the outreach table is still empty.
  const res = applyPlan(PLAN);
  assert.ok(res.notWired.some((n) => /Outreach/.test(n)), "the destination is named as not wired up");

  const fromTable = applyPlan({ ...PLAN, source: { kind: "from_table", fromTable: "Companies", note: "" }, destination: { kind: "none", note: "" } });
  assert.ok(fromTable.notWired.some((n) => /Companies/.test(n)));
  assert.equal(fromTable.webhookToken, undefined, "no webhook when rows come from a table");
});

test("a malformed request degrades that column instead of failing the build", () => {
  const res = applyPlan({
    ...PLAN,
    columns: [
      { name: "Fine", kind: "static", valueType: "text" },
      { name: "Broken", kind: "http", valueType: "text", http: { method: "SUMMON", url: "not a url at all" } },
    ],
  });
  const cols = listColumns(res.sheet.id);
  assert.equal(cols.length, 2, "the good column still exists");
  const broken = cols.find((c) => c.name === "Broken")!;
  // Either it normalized to something harmless or it fell back to a plain column — what must NOT
  // happen is losing the rest of the table over one bad field.
  if (broken.kind === "static") {
    assert.ok(res.notWired.some((n) => /Broken/.test(n)), "and the user is told which one needs attention");
  }
});

test("the table it builds is a real table in the workspace", () => {
  const before = listSheets().length;
  const res = applyPlan({ ...PLAN, name: "Wizard built" });
  assert.equal(listSheets().length, before + 1);
  assert.ok(listSheets().some((s) => s.id === res.sheet.id && s.name === "Wizard built"));
});

test("the plan cannot turn on private addresses, and its references are stored", () => {
  // A plan is model-authored JSON. `allowPrivate` decides whether a request can reach the machine
  // this engine runs on, which holds the provider keys — so it is taken from the defaults rather
  // than from the plan, exactly as an AI-setup proposal is.
  const res = applyPlan({
    ...PLAN,
    columns: [
      { name: "Domain", kind: "static", valueType: "url" },
      {
        name: "Headcount", kind: "http", valueType: "number",
        http: {
          method: "GET", url: "http://169.254.169.254/latest/meta-data/",
          query: [{ name: "domain", value: "/Domain" }],
          allowPrivate: true, maxRetries: 9,
        },
      },
    ],
    dedupeOn: undefined,
  });

  const http = listColumns(res.sheet.id).find((c) => c.name === "Headcount")!.httpConfig as any;
  assert.equal(http.allowPrivate, false);
  assert.equal(http.maxRetries, 2, "retry policy is the user's spend decision, not the plan's");
  assert.equal(
    http.query[0].value,
    `{{col:${listColumns(res.sheet.id).find((c) => c.name === "Domain")!.id}}}`,
    "a reference to a column defined earlier in the same plan resolves",
  );
});

test("a prompt no person would type is dropped from the plan rather than shortened", () => {
  // It is sent once per row, so its length is multiplied by the sheet.
  const step = parseStep({
    step: "plan",
    plan: {
      name: "T", summary: "s",
      columns: [{ name: "A", kind: "ai", valueType: "text", prompt: "x".repeat(50_000) }],
      source: { kind: "manual", note: "" },
      destination: { kind: "none", note: "" },
    },
  });
  assert.equal(step.step === "plan" ? step.plan.columns[0]!.prompt : "unset", undefined);
});
