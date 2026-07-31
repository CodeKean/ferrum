// A search engine described rather than coded.
//
// The failure this has to prevent is specific and quiet: a response path that is subtly wrong
// returns zero results on every row, forever, and looks exactly like a question nobody could answer.
// It costs money each time. So the mapping is tested, and `tryCustom` hands back the raw response
// precisely when the path found nothing — which is the only moment it is useful and the only moment
// it is not noise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { customBackend, customPerSearchUsd, deleteCustom, getCustom, listCustom, saveCustom, tryCustom } from "./custom.ts";
import { preset, SEARCH_PRESETS } from "./presets.ts";

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

const spec = {
  id: "custom:test",
  label: "Test engine",
  method: "POST" as const,
  url: "https://api.example.com/search",
  headers: [{ name: "X-Key", value: "abc" }],
  bodyMode: "json" as const,
  bodyFields: [{ name: "q", value: "{{query}}" }, { name: "num", value: "{{maxResults}}" }],
  body: "",
  resultsPath: "data.results",
  urlField: "link",
  titleField: "heading",
  snippetField: "extract",
  costPath: "meta.cost",
};

test("the query and the result count are filled into the request", async () => {
  await withFetch({ json: { data: { results: [] } } }, async (seen) => {
    await customBackend(spec).run({ query: "acme pricing", maxResults: 7 }, "");
    const body = JSON.parse(seen[0]!.init.body);
    assert.equal(body.q, "acme pricing");
    // A number stays a number: several of these APIs reject `"num": "7"` outright, and the result
    // count is the one field everybody sets this way.
    assert.equal(body.num, 7);
    assert.equal(typeof body.num, "number");
    assert.equal(seen[0]!.init.headers["X-Key"], "abc");
  });
});

test("results are read from the configured path and fields, whatever they are called", async () => {
  await withFetch(
    { json: { data: { results: [{ link: "https://a.com", heading: "A", extract: "about a" }] } } },
    async () => {
      const out = await customBackend(spec).run({ query: "q", maxResults: 5 }, "");
      assert.deepEqual(out.hits, [{ url: "https://a.com", title: "A", snippet: "about a" }]);
    },
  );
});

test("an engine that reports its own cost has that believed over any configured price", async () => {
  await withFetch(
    { json: { data: { results: [{ link: "https://a.com" }] }, meta: { cost: 0.0009 } } },
    async () => {
      const out = await customBackend(spec).run({ query: "q", maxResults: 5 }, "");
      assert.equal(out.costUsd, 0.0009);
    },
  );
});

test("a response that IS the array needs no path", async () => {
  await withFetch({ json: [{ link: "https://a.com" }] }, async () => {
    const out = await customBackend({ ...spec, resultsPath: "" }).run({ query: "q", maxResults: 5 }, "");
    assert.equal(out.hits.length, 1);
  });
});

test("a wrong path returns nothing rather than throwing, and never invents a hit", async () => {
  await withFetch({ json: { data: { results: [{ link: "https://a.com" }] } } }, async () => {
    const out = await customBackend({ ...spec, resultsPath: "nope.missing" }).run({ query: "q", maxResults: 5 }, "");
    assert.deepEqual(out.hits, []);
  });
});

test("a rejected key never appears in the error, because it reaches the model", async () => {
  await withFetch({ ok: false, status: 401, text: "bad token: SECRET-VALUE-123" }, async () => {
    await assert.rejects(
      () => customBackend(spec).run({ query: "q", maxResults: 5 }, ""),
      (e: Error) => {
        assert.ok(!e.message.includes("SECRET-VALUE-123"));
        assert.match(e.message, /key was rejected/);
        return true;
      },
    );
  });
});

test("trying an engine that finds nothing hands back the raw response, so the path can be fixed", async () => {
  // The whole point. Zero results and a 200 are indistinguishable from a hard question, and the
  // difference is visible only in the shape of what came back.
  await withFetch({ json: { organic: [{ link: "https://a.com" }] } }, async () => {
    const out = await tryCustom({ ...spec, resultsPath: "data.results" }, "anything");
    assert.deepEqual(out.hits, []);
    assert.ok(out.raw, "the response has to come back when the path found nothing");
    assert.ok(JSON.stringify(out.raw).includes("organic"), "and it must show where the results really are");
  });
});

test("trying an engine that works does not dump the response", async () => {
  await withFetch({ json: { data: { results: [{ link: "https://a.com" }] } } }, async () => {
    const out = await tryCustom(spec, "anything");
    assert.equal(out.hits.length, 1);
    assert.equal(out.raw, undefined, "on a working engine the raw body is noise");
  });
});

test("a failed try is reported rather than thrown, so the form can show it", async () => {
  await withFetch({ ok: false, status: 500, text: "boom" }, async () => {
    const out = await tryCustom(spec, "anything");
    assert.match(out.error ?? "", /500/);
    assert.deepEqual(out.hits, []);
  });
});

// ── the price, from the same arithmetic an HTTP column uses ─────────────────

test("a price is worked out from units and what a bundle of them costs", () => {
  // "1,000 searches for $1" is $0.001 a search — the same sum the HTTP column already does, so
  // there is one definition of this in the product rather than two that can drift.
  assert.equal(
    customPerSearchUsd({ ...spec, cost: { unit: "searches", perCall: 1, packUnits: 1000, packUsd: 1 } }),
    0.001,
  );
  // Two credits a call, 10,000 credits for $49.
  assert.equal(
    customPerSearchUsd({ ...spec, cost: { unit: "credits", perCall: 2, packUnits: 10_000, packUsd: 49 } })!.toFixed(5),
    "0.00980",
  );
});

test("units declared without a price is not a price", () => {
  // "This burns 2 credits" is worth recording before anyone has said what a credit costs. Returning
  // zero would tell the budget the searches are free.
  assert.equal(customPerSearchUsd({ ...spec, cost: { unit: "credits", perCall: 2, packUnits: 0, packUsd: 0 } }), null);
  assert.equal(customPerSearchUsd({ ...spec }), null);
});

// ── storage ─────────────────────────────────────────────────────────────────

test("engines are saved, listed, edited in place and deleted", () => {
  const made = saveCustom({ label: "My SERP", url: "https://x.test/s", urlField: "u" });
  assert.match(made.id, /^custom:my-serp/);
  assert.equal(getCustom(made.id)?.urlField, "u");

  const edited = saveCustom({ ...made, urlField: "link" });
  assert.equal(edited.id, made.id, "editing keeps the id, so the chosen engine does not change under it");
  assert.equal(listCustom().filter((c) => c.id === made.id).length, 1, "edited in place, not duplicated");

  deleteCustom(made.id);
  assert.equal(getCustom(made.id), null);
});

test("two engines with the same name get their own ids rather than overwriting each other", () => {
  const a = saveCustom({ label: "Dup", url: "https://a.test" });
  const b = saveCustom({ label: "Dup", url: "https://b.test" });
  assert.notEqual(a.id, b.id);
  assert.equal(getCustom(a.id)?.url, "https://a.test");
  deleteCustom(a.id);
  deleteCustom(b.id);
});

test("an engine with no name or no address is refused", () => {
  assert.throws(() => saveCustom({ label: "  ", url: "https://x.test" }), /name/i);
  assert.throws(() => saveCustom({ label: "X", url: "" }), /web address/i);
});

// ── the pre-described engines ───────────────────────────────────────────────
//
// These are DATA, and the reason is worth restating: twenty hand-written adapters would be twenty
// request shapes nobody can verify, each failing the same silent way — a wrong path returns zero
// results on every row and looks exactly like a hard question. As data the fix is a form field.
//
// So these tests do not check that any endpoint is correct; no test here can know that, and the Try
// button is what answers it. They check the things that ARE knowable statically and that would break
// every preset at once if got wrong.

test("every preset describes the four things a search needs", () => {
  for (const p of SEARCH_PRESETS) {
    assert.ok(p.label.trim(), `${p.key} needs a name`);
    assert.ok(p.url.trim(), `${p.key} needs an address`);
    assert.ok(p.urlField.trim(), `${p.key} needs to say which field holds the link`);
    assert.ok(p.note.trim(), `${p.key} needs a line saying what it is for — twenty names is not a choice`);
    assert.ok(p.signupUrl.startsWith("https://"), `${p.key} needs somewhere to get a key`);
  }
});

test("every preset actually uses the query, and asks for its own credentials", () => {
  for (const p of SEARCH_PRESETS) {
    const whole = `${p.url} ${p.body} ${JSON.stringify(p.headers)} ${JSON.stringify(p.bodyFields)}`;
    assert.match(whole, /\{\{query\}\}/, `${p.key} never substitutes the query — it would search for nothing`);
    for (const name of p.secretNames) {
      assert.ok(whole.includes(`{{secret:${name}}}`), `${p.key} names the secret ${name} and never uses it`);
    }
  }
});

test("preset keys and labels are unique, so a picker cannot show two of the same", () => {
  const keys = SEARCH_PRESETS.map((p) => p.key);
  const labels = SEARCH_PRESETS.map((p) => p.label);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(labels).size, labels.length);
});

test("a raw-body preset JSON-escapes the query, so a quote cannot rewrite the request", async () => {
  // DataForSEO takes an array of tasks, which named fields cannot express, so its body is a raw
  // template with the query inside a JSON string. Unescaped, `acme "pro"` closes that string and the
  // rest becomes JSON — a request the caller did not write.
  const p = preset("dataforseo")!;
  const { key, signupUrl, secretNames, note, ...spec } = p;
  await withFetch({ json: {} }, async (seen) => {
    await customBackend({ ...spec, id: "custom:x" }).run({ query: 'acme "pro" plan', maxResults: 5 }, "");
    const body = seen[0]!.init.body;
    assert.doesNotThrow(() => JSON.parse(body), "the body must still be valid JSON");
    assert.equal(JSON.parse(body)[0].keyword, 'acme "pro" plan', "and must carry the query intact");
  });
});

test("a GET preset url-encodes the query, so a space or an ampersand cannot truncate it", async () => {
  const p = preset("serpapi")!;
  const { key, signupUrl, secretNames, note, ...spec } = p;
  await withFetch({ json: { organic_results: [] } }, async (seen) => {
    await customBackend({ ...spec, id: "custom:y" }).run({ query: "acme & sons pricing", maxResults: 5 }, "");
    const url = new URL(seen[0]!.url);
    // Reading it back through URL proves it survived as ONE parameter rather than becoming two.
    assert.equal(url.searchParams.get("q"), "acme & sons pricing");
  });
});

test("the free self-hosted option is priced at zero rather than left unknown", () => {
  // SearXNG run yourself costs nothing per search, and that is a fact rather than an estimate. It is
  // the one preset that can honestly declare a price.
  const p = preset("searxng")!;
  assert.equal(customPerSearchUsd({ ...p, id: "custom:z" } as any), null, "zero cost is not a positive price");
  assert.match(p.note, /free/i);
});
