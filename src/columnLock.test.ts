// Which columns take a typed-in value.
//
// The ordering tests are the ones that matter. Every column that produces its own value is stored in
// a way that overlaps with another — a derived child IS a script column, and a column carrying a
// rule can still be stored as `static` — so a rule that checks the obvious field first gives the
// right verdict with the wrong reason, and a reason that describes the storage rather than the
// situation sends someone to the wrong screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isEditable, lockReason, overrideWarning } from "./columnLock.ts";

// ── what is editable ────────────────────────────────────────────────────────

test("a plain typed column is the only thing you can type into", () => {
  assert.equal(lockReason({ kind: "static" }), null);
  assert.equal(isEditable({ kind: "static" }), true);
});

test("every lane that runs is locked, and each says what it produces", () => {
  // A locked column with no sentence is a grid that ignores keystrokes for no stated reason, which
  // reads as broken rather than as protected.
  for (const kind of ["script", "http", "mcp", "ai", "agent", "send", "lookup", "rollup"]) {
    const why = lockReason({ kind });
    assert.ok(why, `${kind} must be locked`);
    assert.ok(why!.length > 20, `${kind} must say why`);
  }
});

test("a kind nobody has added yet is locked, not waved through", () => {
  // The safe default. A new lane added later without touching this file arrives protected rather
  // than arriving hand-editable and staying that way until someone notices.
  const why = lockReason({ kind: "waterfall" });
  assert.ok(why);
  assert.match(why!, /produces its own value/i);
});

// ── the ordering traps ──────────────────────────────────────────────────────

test("a derived child names its source, rather than calling itself a rule", () => {
  // A projection is STORED as kind "script". Checking the kind first gives the right verdict — it is
  // locked either way — with a sentence that describes the storage instead of the situation, and
  // sends someone looking for a rule that does not exist.
  const why = lockReason(
    { kind: "script", sourceColumnId: 12, jsonPath: "contact.email" },
    "Company JSON",
  );
  assert.match(why!, /Company JSON/, "it names where the value comes from");
  assert.match(why!, /contact\.email/, "and which part of it");
  assert.doesNotMatch(why!, /rule/i, "and does not call a projection a rule");
});

test("a derived child whose source has been deleted still explains itself", () => {
  // Falls back to a worse sentence rather than to a crash. The column is still a projection; the
  // name is simply gone.
  const why = lockReason({ kind: "script", sourceColumnId: 12, jsonPath: "email" }, null);
  assert.ok(why);
  assert.match(why!, /another column/i);
});

test("a static column carrying a rule is locked, because the rule writes it", () => {
  // The edge case a kind-only rule misses entirely. `mapJsonField` in derive.ts proves a column can
  // be stored `static` and still have a transform script attached — and such a column would read as
  // editable while the next run overwrites whatever was typed into it.
  const why = lockReason({ kind: "static", transformScriptId: 7 });
  assert.ok(why, "a rule-backed column is not editable just because it is stored as static");
  assert.match(why!, /rule/i);
});

test("being derived beats carrying a rule, when a column is both", () => {
  // Both are true of a mapped field: it is a projection AND `mapJsonField` may have left a transform
  // id behind. The projection is the useful explanation.
  const why = lockReason(
    { kind: "script", sourceColumnId: 3, jsonPath: "a.b", transformScriptId: 9 },
    "Source",
  );
  assert.match(why!, /pulled out of/i);
});

test("a source id with no path is not a projection", () => {
  // Half the pair is not the pattern. Falling into the derived branch on a stray id would produce a
  // sentence naming a path that is not there.
  const why = lockReason({ kind: "static", sourceColumnId: 4, jsonPath: null });
  assert.equal(why, null);
});

// ── the override warnings ───────────────────────────────────────────────────

test("overriding an API column says the call still happens and is still billed", () => {
  // The non-obvious one, and the reason to have per-kind warnings at all. Pinning protects the
  // WRITE, not the CALL — somebody overriding a cell to stop paying for it would go on paying.
  const w = overrideWarning({ kind: "http" });
  assert.match(w, /still.*(call|bill)/i);
});

test("overriding a send receipt says it does not un-send anything", () => {
  const w = overrideWarning({ kind: "send" });
  assert.match(w, /un-send|already/i);
});

test("overriding a derived cell promises a way back", () => {
  const w = overrideWarning({ kind: "script", sourceColumnId: 1, jsonPath: "x" });
  assert.match(w, /flagged/i, "it says the divergence will be visible");
  assert.match(w, /back/i, "and that it is reversible");
});

test("every locked kind has an override warning, so none of them is a blank dialog", () => {
  for (const kind of ["script", "http", "mcp", "ai", "agent", "send", "lookup", "rollup"]) {
    assert.ok(overrideWarning({ kind }).length > 20, `${kind} needs a warning`);
  }
});

// ── the bundle invariant ────────────────────────────────────────────────────

test("columnLock imports nothing, so the grid can ask before it opens an editor", () => {
  const src = readFileSync(new URL("./columnLock.ts", import.meta.url), "utf8");
  const imports = src.match(/^\s*import[\s{*]/gm) ?? [];
  assert.equal(imports.length, 0, `columnLock.ts must import nothing, found ${imports.length}`);
});
