// Search backends.
//
// Every one of these runs against a FAKE fetch, so the adapters, the price rules and the key
// handling are all verifiable without an account, a network call, or a cent.
//
// The two properties worth guarding are not "does it parse the JSON". They are:
//   - a key never appears in an error message, because these errors reach the model and the cell, and
//   - the price a budget runs on is the one the USER configured, not a rate hardcoded here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { backendImpl, BACKEND_IMPLS } from "./backends.ts";
import { BACKENDS, backendSpec, chosenBackend, perSearchUsd, priceIsCustom, setChosenBackend, setPerSearchUsd } from "./registry.ts";

/** Replace global fetch for one call, and hand back what the adapter asked for. */
async function withFetch<T>(
  reply: { ok?: boolean; status?: number; json?: unknown; text?: string },
  fn: (seen: { url: string; init: any }[]) => Promise<T>,
): Promise<T> {
  const seen: { url: string; init: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      json: async () => reply.json ?? {},
      text: async () => reply.text ?? "",
    } as any;
  }) as any;
  try { return await fn(seen); } finally { globalThis.fetch = real; }
}

const q = { query: "acme pricing", maxResults: 3 };

test("every backend in the catalogue has an implementation, or is the one that is not a SERP API", () => {
  for (const spec of BACKENDS) {
    if (spec.id === "openrouter") {
      // Not a search API at all — a chat call carrying a plugin. It keeps its own path in tools.ts.
      assert.equal(backendImpl(spec.id), null);
      continue;
    }
    assert.ok(backendImpl(spec.id), `${spec.id} is offered in the picker and has no adapter`);
  }
  // And nothing is implemented that the picker never offers, which would be a dead engine.
  for (const id of Object.keys(BACKEND_IMPLS)) {
    assert.ok(backendSpec(id), `${id} has an adapter and no entry in the catalogue`);
  }
});

test("serper sends the query and reads back ranked results", async () => {
  await withFetch(
    { json: { organic: [{ link: "https://acme.com/pricing", title: "Pricing", snippet: "From $29" }] } },
    async (seen) => {
      const out = await backendImpl("serper")!.run(q, "KEY123");
      assert.deepEqual(out.hits, [{ url: "https://acme.com/pricing", title: "Pricing", snippet: "From $29" }]);
      assert.equal(seen[0]!.init.headers["X-API-KEY"], "KEY123");
      assert.match(seen[0]!.init.body, /acme pricing/);
    },
  );
});

test("a domain filter becomes a search operator on engines that take a bare query", async () => {
  await withFetch({ json: { organic: [] } }, async (seen) => {
    await backendImpl("serper")!.run({ ...q, includeDomains: ["acme.com"], excludeDomains: ["spam.io"] }, "K");
    const body = JSON.parse(seen[0]!.init.body);
    assert.match(body.q, /site:acme\.com/);
    assert.match(body.q, /-site:spam\.io/);
  });
});

test("exa reports what the call really cost, and that wins over any configured price", async () => {
  await withFetch(
    { json: { results: [{ url: "https://a.com", title: "A", text: "hello" }], costDollars: { total: 0.0031 } } },
    async () => {
      const out = await backendImpl("exa")!.run(q, "K");
      assert.equal(out.costUsd, 0.0031);
      assert.equal(out.hits[0]!.snippet, "hello");
    },
  );
});

test("an engine that reports no cost returns none, rather than inventing one", async () => {
  // The caller falls back to the configured price. An adapter guessing here would be the same defect
  // as the hardcoded Exa rate: a number that looks measured and is not.
  await withFetch({ json: { organic: [{ link: "https://a.com" }] } }, async () => {
    const out = await backendImpl("serper")!.run(q, "K");
    assert.equal(out.costUsd, undefined);
  });
});

test("results with no url are dropped rather than handed to the model as blanks", async () => {
  await withFetch({ json: { organic: [{ title: "no link" }, { link: "https://a.com" }] } }, async () => {
    const out = await backendImpl("serper")!.run(q, "K");
    assert.deepEqual(out.hits.map((h) => h.url), ["https://a.com"]);
  });
});

test("a rejected key never appears in the error, because that error reaches the model", async () => {
  // The response body of a 401 routinely echoes the credential back. This message is written into
  // the agent transcript and onto the cell, so repeating it would store the key in the database.
  for (const status of [401, 403]) {
    await withFetch({ ok: false, status, text: "invalid api key: SECRET-KEY-VALUE" }, async () => {
      await assert.rejects(
        () => backendImpl("serper")!.run(q, "SECRET-KEY-VALUE"),
        (e: Error) => {
          assert.ok(!e.message.includes("SECRET-KEY-VALUE"), `the key leaked on ${status}: ${e.message}`);
          assert.match(e.message, /key was rejected/);
          return true;
        },
      );
    });
  }
});

test("other failures do report the body, because that is where the useful part is", async () => {
  await withFetch({ ok: false, status: 429, text: "monthly quota exhausted" }, async () => {
    await assert.rejects(
      () => backendImpl("serper")!.run(q, "K"),
      /quota exhausted/,
    );
  });
});

// ── the price, which is a setting ───────────────────────────────────────────

test("a backend's price starts at its list rate and can be corrected", () => {
  assert.equal(perSearchUsd("serper"), backendSpec("serper")!.listPriceUsd);
  assert.equal(priceIsCustom("serper"), false);

  setPerSearchUsd("serper", 0.0004);
  assert.equal(perSearchUsd("serper"), 0.0004);
  assert.equal(priceIsCustom("serper"), true, "the screens have to say the figure came from the user");

  setPerSearchUsd("serper", null);
  assert.equal(perSearchUsd("serper"), backendSpec("serper")!.listPriceUsd, "cleared, back to the list rate");
});

test("a configured price of zero is honoured, not treated as unset", () => {
  // A free tier is a real answer. Reading zero as "nothing stored" and substituting a list price
  // would overrule what the user just told us, on the number a budget is enforced against.
  setPerSearchUsd("brave", 0);
  assert.equal(perSearchUsd("brave"), 0);
  assert.equal(priceIsCustom("brave"), true);
  setPerSearchUsd("brave", null);
});

test("a backend priced by credits has no list rate, so the user has to supply one", () => {
  // Jina, Spider and Firecrawl bill from a credit balance rather than per call. Inventing a
  // per-search figure for them would be a fabrication, and the budget would enforce it.
  for (const id of ["jina", "spider", "firecrawl"]) {
    assert.equal(backendSpec(id)!.listPriceUsd, null, `${id} must not claim a per-search price`);
    assert.match(backendSpec(id)!.priceNote, /set your own/i);
  }
});

test("an unknown backend is refused rather than stored", () => {
  assert.throws(() => setPerSearchUsd("not-a-thing", 1), /Unknown search backend/);
  assert.throws(() => setChosenBackend("not-a-thing"), /Unknown search backend/);
  assert.throws(() => setPerSearchUsd("serper", -1), /zero or more/);
});

test("the chosen backend defaults to the key the app already asks for", () => {
  // A fresh install can search without a second signup; the cheaper engines are an upgrade.
  assert.equal(chosenBackend(), "openrouter");
  setChosenBackend("serper");
  assert.equal(chosenBackend(), "serper");
  setChosenBackend("openrouter");
});
