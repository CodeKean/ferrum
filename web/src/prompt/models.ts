// The model catalogue, fetched once and shared.
//
// Fetched here rather than inside the model picker, which would leave the one screen that most
// needs a model's real price — the mode picker's cost cards — unable to see it, pricing every column
// at a hardcoded gpt-4o-mini instead. Here the picker and the estimate read
// the same list, and so two controls mounted in the same drawer cannot disagree about what a column
// costs.
//
// `/api/models` is free in both senses: no API key and no tokens. It is OpenRouter's published price
// sheet plus whatever local runtimes answered, so it can be read before anything has been spent.

import { useEffect, useState } from "react";

export interface CatalogModel {
  id: string;
  name: string;
  inputPerM: number;
  outputPerM: number;
  contextLength: number;
  tools: boolean;
  free: boolean;
  /** Runs on this machine: no key, no bill, and slower per row. */
  local?: boolean;
}

interface Answer {
  models: CatalogModel[];
  /** The model an "auto" column actually runs on. */
  defaultModel: string;
  /** Set when the engine answered but could not read the price list. */
  error: string | null;
}

export interface ModelCatalog extends Answer {
  /** True until the first answer lands. Distinct from "answered with nothing", which is a real state. */
  loading: boolean;
}

/**
 * One in-flight request for the whole app.
 *
 * The drawer mounts the picker and the estimate in the same frame and both want the list. Two
 * fetches would be two chances for them to price the same column differently.
 */
let cached: Promise<Answer> | null = null;

function load(): Promise<Answer> {
  return (
    cached ??
    (cached = fetch("/api/models")
      .then((r) => r.json())
      .then((res) => ({
        models: (res.models ?? []) as CatalogModel[],
        defaultModel: String(res.defaultModel ?? ""),
        error: res.error ? String(res.error) : null,
      }))
      .catch(() => {
        // A failure is deliberately NOT cached. One dead network moment should not leave every
        // later mount priceless for the life of the page.
        cached = null;
        return { models: [], defaultModel: "", error: "Could not reach the engine to load the model list." };
      }))
  );
}

export function useModelCatalog(): ModelCatalog {
  const [state, setState] = useState<ModelCatalog>({ models: [], defaultModel: "", error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    void load().then((a) => { if (!cancelled) setState({ ...a, loading: false }); });
    return () => { cancelled = true; };
  }, []);

  return state;
}

/** Dollars per million tokens at the 80/20 input/output mix a column actually runs at. */
export const blended = (m: CatalogModel): number => m.inputPerM * 0.8 + m.outputPerM * 0.2;

/**
 * Which model a column really runs on.
 *
 * "auto" is not a model — it is a deferral to the engine's default — so anything pricing an auto
 * column has to resolve it first or it prices nothing at all.
 */
export function resolveModel(catalog: ModelCatalog, stored: string | null | undefined): CatalogModel | null {
  const id = stored && stored !== "auto" ? stored : catalog.defaultModel;
  if (!id) return null;
  return catalog.models.find((m) => m.id === id) ?? null;
}
