// What an object row offers, and what it refuses.
//
// The failure mode being fixed is silence: an object row that showed no control looked identical
// whether the control was withheld deliberately or forgotten. So the interesting assertions here are
// as much about the REASON as about the fields — a refusal with no sentence attached is the bug.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addAllLabel, fieldsUnder, objectOffer, type FieldNode } from "./objectFields.ts";

const leaf = (path: string, label: string, kind = "text"): FieldNode => ({ path, label, kind });

const company: FieldNode = {
  path: "company", label: "Company", kind: "object",
  children: [
    leaf("company.name", "Name"),
    leaf("company.employees", "Employees", "number"),
    {
      path: "company.hq", label: "Hq", kind: "object",
      children: [leaf("company.hq.city", "City"), leaf("company.hq.country", "Country")],
    },
    { path: "company.tags", label: "Tags", kind: "array", children: [] },
  ],
};

test("every scalar field under an object is offered, including nested ones", () => {
  // Stopping at the first level would hide half the useful fields of any real API response.
  const f = fieldsUnder(company);
  assert.deepEqual(f.map((x) => x.path), [
    "company.name", "company.employees", "company.hq.city", "company.hq.country",
  ]);
});

test("a nested field's suggested name carries its parent, so two 'City' columns cannot collide", () => {
  const f = fieldsUnder(company);
  assert.equal(f.find((x) => x.path === "company.hq.city")?.name, "Hq City");
  assert.equal(f.find((x) => x.path === "company.name")?.name, "Name");
});

test("a list is left out, because it asks a different question", () => {
  // Fan out into rows, or join into one cell? That cannot be answered in bulk here, so the list
  // action asks it separately.
  assert.ok(!fieldsUnder(company).some((x) => x.path === "company.tags"));
});

test("anything inside a list is left out, because its path is a different thing on every row", () => {
  const withArrayKids: FieldNode = {
    path: "contacts", label: "Contacts", kind: "object",
    children: [
      { path: "contacts.0", label: "Item 1", kind: "object", inArray: true, children: [leaf("contacts.0.email", "Email")] },
      leaf("contacts.total", "Total", "number"),
    ],
  };
  assert.deepEqual(fieldsUnder(withArrayKids).map((x) => x.path), ["contacts.total"]);
});

test("the truncation row is never offered — its path resolves to nothing", () => {
  const n: FieldNode = {
    path: "x", label: "X", kind: "object",
    children: [leaf("x.a", "A"), { path: "x.__more", label: "…", kind: "null", placeholder: true }],
  };
  assert.deepEqual(fieldsUnder(n).map((f) => f.path), ["x.a"]);
});

test("a very wide object is capped rather than creating a hundred columns in one press", () => {
  const wide: FieldNode = {
    path: "w", label: "W", kind: "object",
    children: Array.from({ length: 90 }, (_, i) => leaf(`w.f${i}`, `F${i}`)),
  };
  assert.equal(fieldsUnder(wide).length, 40);
  // And the button says the number, so nobody presses it blind.
  assert.match(addAllLabel(fieldsUnder(wide).length), /40 fields/);
});

// ── the refusals, which must always explain themselves ──────────────────────

test("an object inside a list refuses AND names the alternative", () => {
  const item: FieldNode = {
    path: "contacts.0", label: "Item 1", kind: "object", inArray: true,
    children: [leaf("contacts.0.email", "Email")],
  };
  const offer = objectOffer(item);
  assert.equal(offer.fields.length, 0);
  assert.ok(offer.reason, "a refusal with no sentence is the defect being fixed");
  // Someone looking at "Item 1" wants the email out of every contact, and that column exists.
  assert.match(offer.reason!, /field/i);
});

test("an object with nothing usable still says so rather than showing nothing", () => {
  const empty: FieldNode = { path: "meta", label: "Meta", kind: "object", children: [] };
  const offer = objectOffer(empty);
  assert.equal(offer.fields.length, 0);
  assert.ok(offer.reason);
});

test("an ordinary object offers its fields and gives no reason, because there is nothing to excuse", () => {
  const offer = objectOffer(company);
  assert.equal(offer.reason, null);
  assert.equal(offer.fields.length, 4);
});

test("the label is singular for one field", () => {
  assert.equal(addAllLabel(1), "Add 1 field");
  assert.equal(addAllLabel(2), "Add 2 fields");
});
