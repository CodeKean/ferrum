// The AI-setup path end to end, against a stub that speaks the OpenAI wire format.
//
// Nothing is billed and nothing leaves the machine: the column is pointed at a local model id and
// the stub answers on the port a local runtime would. That is the whole point — this exercises the
// prompt, the forced tool call, the parse, the guards and the change summary, none of which need a
// real model to be worth testing, and all of which would otherwise only ever be tested by spending
// money.
//
// The stub answers like a model that has been talked into overreaching: it asks for private
// addresses, five retries and a two-minute timeout on a column whose owner allowed none of those.
// If the guards ever stop holding, this is where it shows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Column } from "../types.ts";
// Nothing that reaches the local runtime is imported at the top of this file. The runtime's base URL
// is read once, when its module first loads, so a top-level import here would fix it to the default
// port before the test has had a chance to point it at the stub — and the call would then go to
// whatever is really listening on that port. Every such import is dynamic, below, after the env var.

const ANSWER = {
  why: "It asks the lookup service about each company's website and keeps the industry it sends back.",
  kind: "http",
  valueType: "text",
  http: {
    method: "GET",
    url: "https://api.clearbit.com/v2/companies/find",
    query: [{ name: "domain", value: "/Website" }],
    headers: [{ name: "Authorization", value: "Bearer YOUR_API_KEY" }],
    responsePath: "category.industry",
    fireAndForget: false,
    // None of these may survive.
    allowPrivate: true,
    maxRetries: 5,
    retryOnFailure: true,
    timeoutMs: 120_000,
  },
  missing: ["Your Clearbit API key, in place of YOUR_API_KEY in the Authorization header."],
};

async function stub(): Promise<{ server: Server; port: number; lastRequest: () => any }> {
  let last: any = null;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.url?.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"stub"}]}');
        return;
      }
      last = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        model: "stub",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{
              id: "c1", type: "function",
              function: { name: "configure_column", arguments: JSON.stringify(ANSWER) },
            }],
          },
        }],
        usage: { prompt_tokens: 900, completion_tokens: 200 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as AddressInfo).port, lastRequest: () => last };
}

const column = (): Column =>
  ({
    id: "99", sheetId: "s", name: "Industry", key: "industry", position: 3,
    kind: "script", valueType: "text", promptVersion: 1, model: "local:ollama/stub",
    maxTurns: 4, timeoutMs: 60_000, maxBudgetUsd: 0.05, allowedTools: [],
    // What the user has already chosen. Every one of these is stricter than what the stub asks for.
    httpConfig: {
      method: "GET", url: "", allowPrivate: false, timeoutMs: 5000, maxRetries: 0, retryOnFailure: false,
    },
  }) as never;

test("a setup proposal is built from the real sheet, and cannot escalate what it was not given", async (t) => {
  const { server, port, lastRequest } = await stub();
  t.after(() => server.close());

  // The local runtime's base URL is read when the module loads, so the stub's port has to be in
  // place before the import — hence the dynamic import rather than a top-level one.
  process.env.OLLAMA_URL = `http://127.0.0.1:${port}/v1`;

  // The DESIGN model is a workspace setting, not the column's own. Sharing them means setting a
  // column to a cheap model to keep a big run affordable also downgrades the thing designing it. The column below is deliberately left pointing somewhere
  // else, so that if the two ever get re-coupled this test stops reaching the stub and fails.
  const { setSetupSettings } = await import("./setupModel.ts");
  setSetupSettings({ model: "local:ollama/stub", freeOnly: false });

  const { proposeSetup } = await import(`./aiSetup.ts?stub=${port}`);

  const col = column();
  const proposal = await proposeSetup({
    column: col,
    columns: [
      col,
      { id: "1", name: "Company", valueType: "text" } as Column,
      { id: "2", name: "Website", valueType: "url" } as Column,
    ],
    evidence: {
      sheetId: "s",
      sheetName: "Leads",
      rowCount: 100,
      columns: [
        { id: 1, name: "Company", kind: "static", valueType: "text", filled: 100, errors: 0, empty: 0, fillRate: 1, samples: ["Acme Ltd"], failures: [], errorTypes: [] },
        // Deliberately part-filled. The fill rate is the fact one sample row could never carry, and
        // the assertion below is that it actually reaches the model.
        { id: 2, name: "Website", kind: "static", valueType: "url", filled: 40, errors: 0, empty: 60, fillRate: 0.4, samples: ["acme.com", "https://acme.com/about"], failures: [], errorTypes: [] },
      ],
    },
    intent: "Look up each company's industry from their website using Clearbit",
    area: "request",
  });

  const asked = lastRequest();
  const userTurn = asked.messages[1].content as string;

  // Real values from real rows, not just the column name. "Website" holding `acme.com` and holding
  // `https://acme.com/about` need different requests, and only a sample tells them apart — so BOTH
  // shapes have to arrive, which is what the old one-row-one-value version could not do.
  assert.match(userTurn, /https:\/\/acme\.com\/about/);
  assert.match(userTurn, /"acme\.com"/);
  // And the fill rate, which is what stops a request being built against a column that is empty on
  // most rows.
  assert.match(userTurn, /\/Website \(url, static\) — 40% filled/);
  // Offered in the one notation the user sees. A model shown braces would emit braces, and the
  // request screen would then display a reference in a notation it has just stopped teaching.
  assert.match(userTurn, /\/Website/);
  assert.doesNotMatch(userTurn, /\{\{/);
  assert.equal(asked.tool_choice, "required", "the model must answer with a configuration, not prose");

  // ── The guards. The stub asked for all four; none of them may have moved. ──
  assert.equal(proposal.http.allowPrivate, false, "a model may never open the private-address door");
  assert.equal(proposal.http.retryOnFailure, false);
  assert.equal(proposal.http.maxRetries, 0);
  assert.equal(proposal.http.timeoutMs, 5000);

  // ── What it IS allowed to set came through. ──
  assert.equal(proposal.kind, "http");
  // And the address survives untouched: every slash in it follows a letter, so none of them is a
  // reference. This is the assertion that would fail first if the boundary rule ever loosened.
  assert.equal(proposal.http.url, "https://api.clearbit.com/v2/companies/find");
  // The model writes /Website; what gets stored is the id, so a later rename cannot break it.
  assert.deepEqual(proposal.http.query, [{ name: "domain", value: "{{col:2}}" }]);
  assert.equal(proposal.http.responsePath, "category.industry");

  // ── The summary a person reads before agreeing. ──
  const labels = proposal.changes.map((c: { label: string }) => c.label);
  assert.deepEqual(labels, ["How it runs", "Address", "Query parameters", "Headers", "Field to keep"]);
  const kind = proposal.changes.find((c: { field: string }) => c.field === "kind");
  assert.equal(kind.before, "A rule");
  assert.equal(kind.after, "Call an API");

  // What it could not work out is surfaced, rather than a placeholder shipping silently.
  assert.match(proposal.missing[0], /API key/i);
  // A local model costs nothing, which is stated rather than left blank-and-unknown.
  assert.equal(proposal.costUsd, null);
});
