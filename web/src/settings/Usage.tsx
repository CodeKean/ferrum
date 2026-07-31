// What this workspace has spent, and on what.
//
// The engine could already say what one RUN cost. It could not say what a COLUMN costs, what a table
// costs, where the money went, or whether this week was worse than last — so the only way to answer
// "why is this expensive" was to remember. This is the screen for that question.
//
// ── Three scopes, one screen ────────────────────────────────────────────────────────────────────
//
// Workspace, workbook and table are the same report with a different WHERE, so they are one screen
// with a scope picker rather than three that drift apart. The scope lives in the address, so a table's
// cost page can be linked to and reloaded into.
//
// ── Why the breakdowns arrive together ──────────────────────────────────────────────────────────
//
// All of them come from one request. Fetched separately, the total and its own breakdown could
// disagree while you looked at them — and a cost screen that contradicts itself is worse than none,
// because the number here is believed and nobody re-derives it.
//
// ── What is deliberately NOT rounded ───────────────────────────────────────────────────────────
//
// A per-row price is often a fraction of a cent. Rounded to two places it reads $0.00, which is the
// exact wrong answer: it says free about something that is not. So small numbers keep their digits.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SavingsTotals, type UsageReport, type UsageScope, type UsageSlice } from "../api.ts";
import { Select } from "../ui/Select.tsx";
import "./Usage.css";

/**
 * Money, honestly.
 *
 * Zero is "$0" rather than "$0.00" — a plain zero reads as nothing spent, where two decimal places
 * read as a rounded number and invite the question of what was rounded away.
 */
export function money(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return "$0";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd >= 0.000001) return `$${usd.toFixed(6).replace(/0+$/, "")}`;
  return "under $0.000001";
}

/** Counts, with the separators that make six figures readable at a glance. */
const num = (n: number): string => Math.round(n).toLocaleString();

/** Units can be fractional (half a credit a call), so they keep a decimal only when they need one. */
const units = (n: number): string =>
  Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 90) return `${m.toFixed(1)} min`;
  return `${(m / 60).toFixed(1)} hours`;
}

/** Today and N days ago, as the YYYY-MM-DD the server buckets on. UTC, to match how days are cut. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

type RangeId = "7" | "30" | "90" | "all";

const RANGES: Array<{ value: RangeId; label: string }> = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const rangeFrom = (r: RangeId): string | null => (r === "all" ? null : daysAgo(Number(r) - 1));

/** The lane names the engine stores, in the words the rest of the app uses. */
const LANE_LABEL: Record<string, string> = {
  ai: "Ask a model",
  agent: "Agent",
  http: "API call",
  send: "Send to a table",
  script: "Rule",
  mcp: "Connected app",
  lookup: "Lookup",
  rollup: "Rollup",
  static: "Typed in",
};

interface Props {
  scope: UsageScope;
  scopeId: string | null;
  onScope: (scope: UsageScope, id: string | null) => void;
}

export function Usage({ scope, scopeId, onScope }: Props) {
  const [report, setReport] = useState<UsageReport | null>(null);
  /** What was not spent. Null on a workbook, where it cannot be computed honestly — see the route. */
  const [savings, setSavings] = useState<SavingsTotals | null>(null);
  const [range, setRange] = useState<RangeId>("30");
  const [error, setError] = useState<string | null>(null);
  /**
   * Distinguished from "no report yet" so the first paint is a skeleton and every later one keeps
   * the numbers on screen while it refetches. A total that blinks to empty on every filter change
   * reads as the spend having been wiped.
   */
  const [loading, setLoading] = useState(true);

  const [sheets, setSheets] = useState<Array<{ id: string; name: string; workbookId?: string | null }>>([]);
  const [workbooks, setWorkbooks] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    void Promise.all([api.listSheets(), api.listWorkbooks()])
      .then(([s, w]) => {
        setSheets(s.sheets.map((x: any) => ({ id: x.id, name: x.name, workbookId: x.workbookId ?? null })));
        setWorkbooks(w.workbooks);
      })
      .catch(() => { /* the scope picker degrades to workspace-only; the report itself still loads */ });
  }, []);

  /**
   * Bumped on every load, so a slow answer for a scope or a range you have already moved off cannot
   * paint over the one you are looking at now. This is the screen whose whole job is saying what a
   * given table cost — one workspace's figures under another table's name is not a stale number, it
   * is a wrong one, and nothing on screen would say so.
   */
  const ticket = useRef(0);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    setLoading(true);
    try {
      const r = await api.usage(scope, scopeId, { from: rangeFrom(range) });
      if (mine !== ticket.current) return;
      setReport(r.report);
      setSavings(r.savings ?? null);
      setError(null);
    } catch (e) {
      if (mine !== ticket.current) return;
      setError(e instanceof Error ? e.message : "Could not read the usage history.");
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
  }, [scope, scopeId, range]);

  useEffect(() => { void load(); }, [load]);

  /**
   * One picker for all three scopes, because they are one choice.
   *
   * Two controls — a scope switch and then a thing to pick — would leave "workbook" selectable with
   * nothing chosen, which is a state that has to mean something and does not.
   */
  const scopeOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string; group?: string }> = [
      { value: "workspace:", label: "This whole workspace", group: "Everything" },
    ];
    for (const w of workbooks) opts.push({ value: `workbook:${w.id}`, label: w.name, group: "Workbooks" });
    for (const s of sheets) opts.push({ value: `table:${s.id}`, label: s.name, group: "Tables" });
    return opts;
  }, [workbooks, sheets]);

  const scopeValue = `${scope}:${scopeId ?? ""}`;

  const t = report?.totals;
  const spent = t?.costUsd ?? 0;
  const attempts = t?.attempts ?? 0;

  /**
   * Cost per attempt, computed HERE from the two totals rather than averaged from the breakdown.
   *
   * Averaging the per-model averages would weight a model that ran twice the same as one that ran a
   * million times, and produce a plausible number that is wrong.
   */
  const each = attempts > 0 ? spent / attempts : 0;

  return (
    <div className="cc-usage">
      <div className="cc-usage__bar">
        <Select
          label="Show"
          value={scopeValue}
          options={scopeOptions}
          searchable
          onChange={(v) => {
            const i = v.indexOf(":");
            const s = v.slice(0, i) as UsageScope;
            const id = v.slice(i + 1);
            onScope(s, id || null);
          }}
        />
        <Select label="Over" value={range} options={RANGES} onChange={(v) => setRange(v as RangeId)} />
        <button className="cc-btn cc-usage__refresh" onClick={() => void load()} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>

      {error && <div className="cc-errors" role="alert"><div className="cc-errors__row">{error}</div></div>}

      {/* Skeletons match the real shapes so nothing jumps when the numbers land. */}
      {!report && loading && (
        <div className="cc-usage__stats">
          {[0, 1, 2, 3].map((i) => <div key={i} className="cc-usage__stat cc-usage__stat--skel" />)}
        </div>
      )}

      {report && (
        <>
          <div className="cc-usage__stats">
            <Stat k="Spent" v={money(spent)} sub={report.scopeName} />
            <Stat k="Cells run" v={num(attempts)} sub={RANGES.find((r) => r.value === range)?.label.toLowerCase()} />
            <Stat k="Each one" v={attempts > 0 ? money(each) : "—"} sub="on average" />
            <Stat
              k="Failed"
              v={num(t?.errors ?? 0)}
              sub={attempts > 0 ? `${((100 * (t?.errors ?? 0)) / attempts).toFixed(1)}% of them` : undefined}
              // A failure is not free — it was still a call, and on most providers still a charge.
              warn={(t?.errors ?? 0) > 0}
            />
            {/* What was NOT spent, beside what was.
                Only when there is something to say: a "Saved $0" on a workspace that has never
                re-run anything is a claim about the product, not a fact about the user's work.
                Absent entirely on a workbook, where the figure cannot be computed honestly — see
                the route — rather than shown as zero. */}
            {savings && (savings.usd > 0 || savings.cells > 0) && (
              <Stat
                k="Not spent"
                v={money(savings.usd)}
                sub={`${num(savings.cells)} cells not re-bought`}
              />
            )}
          </div>

          {/* Where the saving came from, and — just as important — what part of it could not be
              priced. A total that quietly omits the cells it could not value is a total that
              overstates its own certainty. */}
          {savings && savings.byReason.length > 0 && (
            <div className="cc-usage__units">
              {savings.byReason.map((r) => (
                <div key={r.reason} className="cc-usage__unit">
                  <span className="cc-usage__unit__v">{money(r.usd)}</span>
                  <span className="cc-usage__unit__k">{r.label.toLowerCase()}</span>
                </div>
              ))}
              {savings.cellsUnpriced > 0 && (
                <div className="cc-usage__unit">
                  <span className="cc-usage__unit__v">{num(savings.cellsUnpriced)}</span>
                  <span className="cc-usage__unit__k">cells at an unknown price</span>
                </div>
              )}
            </div>
          )}

          {/* Third-party currencies. Only rendered when something declared one, because an empty
              "credits: 0" row on a workspace that uses none is noise pretending to be information. */}
          {report.byUnit.length > 0 && (
            <div className="cc-usage__units">
              {report.byUnit.map((u) => (
                <div key={u.key} className="cc-usage__unit">
                  <span className="cc-usage__unit__v">{units(u.units)}</span>
                  <span className="cc-usage__unit__k">{u.key}</span>
                </div>
              ))}
            </div>
          )}

          {attempts === 0 ? (
            <div className="cc-usage__empty">
              <p className="cc-usage__empty__h">Nothing has run here yet.</p>
              <p className="cc-usage__empty__p">
                {range === "all"
                  ? "Once a column runs, what it cost shows up here — by model, by column and by day."
                  : "Nothing in this period. Try a longer one, or All time."}
              </p>
            </div>
          ) : (
            <>
              <Days rows={report.byDay} />
              <div className="cc-usage__grid">
                <Table title="By column" rows={report.byColumn} total={spent} nameHead="Column" />
                <Table title="By model" rows={report.byModel} total={spent} nameHead="Model" />
                <Table title="By kind of column" rows={report.byLane} total={spent} nameHead="Kind" label={(k) => LANE_LABEL[k] ?? k} />
                {report.scope !== "table" && (
                  <Table title="By table" rows={report.byTable} total={spent} nameHead="Table" />
                )}
              </div>
              <p className="cc-usage__foot">
                Time spent waiting on all of it: {duration(t?.durationMs ?? 0)}. Tokens in {num(t?.tokensIn ?? 0)},
                out {num(t?.tokensOut ?? 0)}
                {(t?.cacheRead ?? 0) > 0 ? `, read from cache ${num(t!.cacheRead)}` : ""}.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Label left, value right, edge to edge — no half-empty box. */
function Stat({ k, v, sub, warn }: { k: string; v: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`cc-usage__stat${warn ? " cc-usage__stat--warn" : ""}`}>
      <span className="cc-usage__stat__k">{k}</span>
      <span className="cc-usage__stat__v">{v}</span>
      {/* Reserved whether or not there is a sub-line, so a stat with one is not taller than a stat
          without one and the row does not shift as the numbers change. */}
      <span className="cc-usage__stat__sub">{sub ?? " "}</span>
    </div>
  );
}

/**
 * Spend per day as bars.
 *
 * Scaled to the busiest day rather than to the total: what this answers is "which day was unusual",
 * and against a total every bar is a sliver.
 */
function Days({ rows }: { rows: UsageSlice[] }) {
  if (rows.length < 2) return null;
  const peak = Math.max(...rows.map((r) => r.costUsd), 0);
  // Every day cost nothing — a workspace running only free and local models. Bars that are all zero
  // say nothing, and a chart scaled to zero would draw them all full height.
  const byCost = peak > 0;
  const scale = byCost ? peak : Math.max(...rows.map((r) => r.attempts), 1);

  return (
    <section className="cc-usage__days">
      <h3 className="cc-usage__h3">
        Per day <span className="cc-usage__h3__note">{byCost ? "by what it cost" : "by how many ran — nothing here cost money"}</span>
      </h3>
      <div className="cc-usage__bars">
        {rows.map((d) => {
          const v = byCost ? d.costUsd : d.attempts;
          return (
            <div
              key={d.key}
              className="cc-usage__bar"
              title={`${d.key} · ${money(d.costUsd)} · ${num(d.attempts)} run${d.attempts === 1 ? "" : "s"}`}
            >
              {/* A day with real spend never renders as nothing: a 1px floor keeps it visible rather
                  than letting a busy day beside it round it out of existence. */}
              <div className="cc-usage__bar__fill" style={{ height: `${v > 0 ? Math.max(2, (v / scale) * 100) : 0}%` }} />
            </div>
          );
        })}
      </div>
      <div className="cc-usage__bars__ends">
        <span>{rows[0]?.label}</span>
        <span>{rows[rows.length - 1]?.label}</span>
      </div>
    </section>
  );
}

/**
 * One breakdown.
 *
 * Sorted by cost by the server. The share bar is drawn against the SCOPE total, not against the
 * biggest row, so the four tables are readable against each other.
 */
function Table(
  { title, rows, total, nameHead, label }:
  { title: string; rows: UsageSlice[]; total: number; nameHead: string; label?: (key: string) => string },
) {
  if (rows.length === 0) return null;
  return (
    <section className="cc-usage__tbl">
      <h3 className="cc-usage__h3">{title}</h3>
      <table className="cc-usage__table">
        <thead>
          <tr>
            <th scope="col">{nameHead}</th>
            <th scope="col" className="cc-usage__num">Runs</th>
            <th scope="col" className="cc-usage__num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="cc-usage__name" title={label ? label(r.key) : r.label}>
                {label ? label(r.key) : r.label}
                {/* Only when the group speaks ONE currency. "9 units" over six credits and three
                    lookups is a number that is not about anything; the chips above already say
                    what was spent in each. */}
                {r.units > 0 && r.unit && (
                  <span className="cc-usage__sub">{units(r.units)} {r.unit}</span>
                )}
              </th>
              <td className="cc-usage__num">{num(r.attempts)}</td>
              <td className="cc-usage__num">
                {money(r.costUsd)}
                <span
                  className="cc-usage__share"
                  style={{ width: total > 0 ? `${Math.min(100, (r.costUsd / total) * 100)}%` : 0 }}
                  aria-hidden="true"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
