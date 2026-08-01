// What would leave with an exported workbook that the sender did not mean to send.
//
// The export menu item used to promise "never a key". That was false, and false in the one direction
// a safety claim must never be wrong in: a key TYPED INTO A HEADER is part of the column's
// definition, so it travels into a duplicate, a template and a `.ferrum.json` file. `secrets.ts`
// opens by calling that the worst thing in the product, and the column-template dialog has always
// warned about it — the workbook export was the one path that denied it.
//
// The two assertions that matter are opposites, and both have to hold:
//   1. a key typed into a column IS found, or the warning never fires and we are back where we
//      started, still telling the user the file is safe;
//   2. a `{{secret:Name}}` reference is NOT found, or the warning fires on the very habit the
//      product is trying to teach — and a warning that cries wolf on correct usage gets dismissed
//      by reflex, which costs more than never having built it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addColumn, createSheet, setColumnHttpConfig } from "./store.ts";
import { literalSecretsIn } from "./workbookCopy.ts";

/** A workbook holding one HTTP column configured with the given headers. */
function withHeaders(headers: Array<{ key: string; value: string }>): { workbookId: string; column: string } {
  const sheet = createSheet("Enrichment");
  const col = addColumn(sheet.id, { name: "Lookup", kind: "http", valueType: "text" });
  setColumnHttpConfig(col.id, { url: "https://api.example.com/v1/find", method: "GET", headers } as any);
  const wb = sheet.workbookId!;
  return { workbookId: wb, column: col.name };
}

test("a key typed straight into a header is found", () => {
  const { workbookId } = withHeaders([{ key: "Authorization", value: "Bearer sk-live-SUPERSECRET-1234567890" }]);
  const found = literalSecretsIn(workbookId);
  assert.equal(found.length, 1, "the column must be reported");
  assert.equal(found[0]?.column, "Lookup");
  assert.equal(found[0]?.table, "Enrichment");
});

test("a provider key by its published prefix is found even without a scheme", () => {
  const { workbookId } = withHeaders([{ key: "X-Api-Key", value: "sk-ant-api03-abcdefghijklmnop" }]);
  assert.equal(literalSecretsIn(workbookId).length, 1);
});

test("a SAVED key referenced by name is NOT reported", () => {
  // The whole point of the named store. Reporting this would be a warning fired at the correct
  // habit, and a warning that fires on correct usage is dismissed by reflex.
  const { workbookId } = withHeaders([{ key: "Authorization", value: "Bearer {{secret:Prospeo}}" }]);
  assert.deepEqual(literalSecretsIn(workbookId), []);
});

test("an ordinary header is not mistaken for a credential", () => {
  const { workbookId } = withHeaders([
    { key: "Accept", value: "application/json" },
    { key: "User-Agent", value: "Ferrum" },
  ]);
  assert.deepEqual(literalSecretsIn(workbookId), []);
});

test("a workbook with nothing to hide reports nothing", () => {
  const sheet = createSheet("Plain");
  addColumn(sheet.id, { name: "Company", valueType: "text" });
  assert.deepEqual(literalSecretsIn(sheet.workbookId!), []);
});

test("the report names columns, never values", () => {
  // It is rendered in a dialog. Putting the value on screen to prove the value is on screen would
  // be its own leak — over a shoulder, in a screenshot, in a support thread.
  const { workbookId } = withHeaders([{ key: "Authorization", value: "Bearer sk-live-SUPERSECRET-1234567890" }]);
  const blob = JSON.stringify(literalSecretsIn(workbookId));
  assert.ok(!blob.includes("SUPERSECRET"), "the secret must not be in the report");
  assert.ok(!blob.includes("sk-live"), "not even its prefix");
});

test("every offending column is listed, not just the first", () => {
  // The dialog is a checklist somebody works through before sending a file. Reporting one of three
  // would have them fix it, export again, and ship the other two believing they were clean.
  const sheet = createSheet("Enrichment");
  for (const name of ["Find email", "Find phone", "Find socials"]) {
    const c = addColumn(sheet.id, { name, kind: "http", valueType: "text" });
    setColumnHttpConfig(c.id, {
      url: "https://api.example.com/v1/find",
      method: "GET",
      headers: [{ key: "Authorization", value: `Bearer sk-live-KEY${name.length}-1234567890` }],
    } as any);
  }
  const clean = addColumn(sheet.id, { name: "Company", valueType: "text" });
  assert.ok(clean.id);

  const found = literalSecretsIn(sheet.workbookId!);
  assert.equal(found.length, 3);
  assert.deepEqual(found.map((f) => f.column).sort(), ["Find email", "Find phone", "Find socials"]);
});
