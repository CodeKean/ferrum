// Types shared with the server. Kept as a small mirror rather than importing across the boundary,
// so the web build has no dependency on the server's module graph.

export type CellStatus =
  | "empty" | "queued" | "running" | "done"
  | "not_found" | "error" | "skipped" | "blocked" | "cancelled";

export interface CellDelta {
  i: string;
  r: number;
  s: CellStatus;
  v?: string | null;
  e?: string;
  m?: string;           // the error MESSAGE, truncated — the class alone explains nothing
  c?: number;
  d?: number;
}

/** Presentation metadata per status. Single source of truth so the cell, the legend, the run strip
 *  and the error popover can never drift apart. */
export const STATUS_META: Record<CellStatus, { label: string; tone: "idle" | "queued" | "running" | "done" | "error"; band: boolean }> = {
  empty:     { label: "Empty",      tone: "idle",    band: false },
  queued:    { label: "Queued",     tone: "queued",  band: true  },
  running:   { label: "Running",    tone: "running", band: true  },
  done:      { label: "Done",       tone: "done",    band: false },
  not_found: { label: "Not found",  tone: "idle",    band: false },
  error:     { label: "Error",      tone: "error",   band: true  },
  skipped:   { label: "Skipped",    tone: "idle",    band: true  },
  blocked:   { label: "Blocked",    tone: "queued",  band: true  },
  cancelled: { label: "Cancelled",  tone: "idle",    band: false },
};

/** Semantic lifecycle order — status columns sort by this, never alphabetically. */
export const STATUS_ORDER: CellStatus[] = [
  "error", "running", "queued", "blocked", "skipped", "not_found", "done", "cancelled", "empty",
];
