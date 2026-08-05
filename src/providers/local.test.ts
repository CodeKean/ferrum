// Local runtimes: parsing, and the properties that keep the free lane reachable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalModel, parseLocalModel, LOCAL_PREFIX } from "./local.ts";

test("a local model id round-trips, including the awkward names", () => {
  const p = parseLocalModel("local:ollama/llama3.1:8b");
  assert.equal(p?.runtime.id, "ollama");
  // Ollama names carry colons and slashes. Splitting on every separator would mangle them into
  // something the runtime does not have, and the failure would be a 404 per row.
  assert.equal(p?.model, "llama3.1:8b");

  assert.equal(parseLocalModel("local:ollama/library/qwen2.5:7b")?.model, "library/qwen2.5:7b");
  assert.equal(parseLocalModel("local:lmstudio/TheBloke/Mistral-7B-GGUF")?.runtime.id, "lmstudio");
});

test("hosted model ids are never mistaken for local ones", () => {
  for (const id of ["openai/gpt-oss-20b", "anthropic/claude-3", "auto", ""]) {
    assert.equal(isLocalModel(id), false, `${id} must not look local`);
    assert.equal(parseLocalModel(id), null);
  }
  assert.equal(isLocalModel(`${LOCAL_PREFIX}ollama/x`), true);
});

test("a malformed local id is rejected rather than half-parsed", () => {
  // No runtime segment, and an unknown runtime. Both would otherwise produce a provider pointed at
  // nothing, failing once per row instead of once at save time.
  assert.equal(parseLocalModel("local:llama3.1"), null);
  assert.equal(parseLocalModel("local:notarealruntime/x"), null);
});

// ── what happened when we knocked ───────────────────────────────────────────
//
// The probe used to answer with an empty list for every kind of failure, so the screen could only
// say "nothing answered at any of those addresses" and then tell the user to install a runtime,
// start it and load a model. With LM Studio running and serving on 1234 that is three instructions,
// two of them already done, and the one that mattered buried in the middle.
//
// These run against real HTTP servers on a loopback port, because the distinction being tested IS
// the difference between a refused connection and a 200 — which a mocked fetch would only be
// asserting about the mock.

import { createServer, type Server } from "node:http";
import { discoverLocalModels, localReach, setLocalUrl } from "./local.ts";

/** A server that answers `/models` with whatever is passed, on a free port. */
function serve(handler: (res: any) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv: Server = createServer((_req, res) => handler(res));
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port as number;
      resolve({ port, close: () => new Promise<void>((done) => srv.close(() => done())) });
    });
  });
}

const reachOf = async (id: string, url: string) => {
  setLocalUrl(id as never, url);
  await discoverLocalModels(true);
  return localReach()[id];
};

test("a server holding no model is told apart from no server at all", async () => {
  // Exactly what LM Studio returns with its server up and nothing loaded — it lists only LOADED
  // models and evicts them when idle, so this is the normal state of a correctly set up machine.
  const s = await serve((res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [] }));
  });
  try {
    assert.equal(await reachOf("lmstudio", `http://127.0.0.1:${s.port}/v1`), "no_models");
  } finally {
    await s.close();
  }
});

test("a port with nothing on it is `off`, which is the only case that means install something", async () => {
  // Taken and released, so the port is real and certain to be closed.
  const s = await serve((res) => res.end("{}"));
  const port = s.port;
  await s.close();
  assert.equal(await reachOf("lmstudio", `http://127.0.0.1:${port}/v1`), "off");
});

test("a server that answers and will not list is `refused`, not `off`", async () => {
  // What LiteLLM and AnythingLLM do without a token. Reported as "not running" before this, so the
  // advice was to start an app that was already running.
  const s = await serve((res) => { res.writeHead(401); res.end("no"); });
  try {
    assert.equal(await reachOf("lmstudio", `http://127.0.0.1:${s.port}/v1`), "refused");
  } finally {
    await s.close();
  }
});

test("models found means `ok`, and they come back with the runtime attached", async () => {
  const s = await serve((res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwen2.5:1.5b" }] }));
  });
  try {
    setLocalUrl("lmstudio" as never, `http://127.0.0.1:${s.port}/v1`);
    const models = await discoverLocalModels(true);
    const mine = models.filter((m) => m.runtime === "lmstudio");
    assert.equal(localReach()["lmstudio"], "ok");
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.id, "local:lmstudio/qwen2.5:1.5b");
  } finally {
    await s.close();
  }
});
