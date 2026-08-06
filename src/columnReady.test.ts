import test from "node:test";
import assert from "node:assert/strict";
import { notReadyReason } from "./columnReady.ts";
import type { Column } from "./types.ts";

// What the run confirmation warns about before it spends anything. Each case here mirrors a real
// refusal in the executor — the point of the file is that the two agree, so the sentence before the
// run and the note on the skipped cell describe the same thing.

const col = (over: Partial<Column>) => ({ kind: "static", ...over } as Column);

test("a lane with no configuration to miss is always ready", () => {
  assert.equal(notReadyReason(col({ kind: "static" })), null);
  assert.equal(notReadyReason(col({ kind: "wait" })), null);
});

test("an AI or agent column needs an instruction", () => {
  assert.equal(notReadyReason(col({ kind: "ai" })), "no instruction yet");
  assert.equal(notReadyReason(col({ kind: "agent", prompt: "   " })), "no instruction yet");
  assert.equal(notReadyReason(col({ kind: "ai", prompt: "What industry?" })), null);
});

test("a script column needs a saved rule", () => {
  assert.equal(notReadyReason(col({ kind: "script" })), "no rule saved yet");
  assert.equal(notReadyReason(col({ kind: "script", transformScriptId: "7" })), null);
});

test("an http column needs an address", () => {
  assert.equal(notReadyReason(col({ kind: "http" })), "no address yet");
  assert.equal(notReadyReason(col({ kind: "http", httpConfig: { url: "  " } })), "no address yet");
  assert.equal(notReadyReason(col({ kind: "http", httpConfig: { url: "https://a.co" } })), null);
});

test("an mcp column needs an app AND a tool, and says which is missing", () => {
  assert.equal(notReadyReason(col({ kind: "mcp" })), "no connected app chosen yet");
  assert.equal(notReadyReason(col({ kind: "mcp", mcpConfig: { serverId: "s1" } })), "no tool chosen yet");
  assert.equal(notReadyReason(col({ kind: "mcp", mcpConfig: { serverId: "s1", tool: "find" } })), null);
});

test("a send column needs a destination table", () => {
  assert.equal(notReadyReason(col({ kind: "send" })), "no destination table yet");
  assert.equal(notReadyReason(col({ kind: "send", sendConfig: { targetSheetId: "abc" } })), null);
});

test("a lookup column needs a link and a field", () => {
  assert.equal(notReadyReason(col({ kind: "lookup" })), "not linked to another table yet");
  assert.equal(notReadyReason(col({ kind: "lookup", relationId: 3 })), "no field chosen to read");
  assert.equal(notReadyReason(col({ kind: "lookup", relationId: 3, lookupColumnId: 9 })), null);
});

test("a rollup column needs a link and a calculation", () => {
  assert.equal(notReadyReason(col({ kind: "rollup" })), "not linked to another table yet");
  assert.equal(notReadyReason(col({ kind: "rollup", relationId: 3 })), "no calculation chosen yet");
  assert.equal(notReadyReason(col({ kind: "rollup", relationId: 3, rollup: { fn: "sum" } })), null);
});

test("a waterfall needs at least one step that is switched on", () => {
  assert.equal(notReadyReason(col({ kind: "waterfall" })), "no steps yet");
  assert.equal(notReadyReason(col({ kind: "waterfall", waterfall: '{"steps":[]}' })), "no steps yet");
  assert.equal(
    notReadyReason(col({ kind: "waterfall", waterfall: '{"steps":[{"enabled":false}]}' })),
    "no steps yet",
  );
  assert.equal(notReadyReason(col({ kind: "waterfall", waterfall: '{"steps":[{"enabled":true}]}' })), null);
});

test("a waterfall step written before the switch existed counts as ON", () => {
  // Reading a missing `enabled` as off would report a working column as empty.
  assert.equal(notReadyReason(col({ kind: "waterfall", waterfall: '{"steps":[{"kind":"ai"}]}' })), null);
});

test("a waterfall whose JSON cannot be read says so rather than claiming it is empty", () => {
  assert.equal(notReadyReason(col({ kind: "waterfall", waterfall: "{not json" })), "its steps could not be read");
});
