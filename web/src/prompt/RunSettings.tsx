// When this column runs, and on which rows.
//
// The run condition is the highest-leverage control in the whole product, which is why it gets a
// screen of its own. `applyConditionGate` narrows the row set before any paid lane sees it, and a
// gate reachable only by editing the database is a gate nobody uses.
//
// What it does is worth being blunt about: a condition costs NOTHING and runs on every row before
// anything decides to spend. Put one in front of a web-search column on a million-row sheet and you
// might pay for four thousand rows instead of a million. That is the difference between this being
// affordable and not, so it gets a screen rather than a checkbox somewhere.
//
// The code is generated once and then reviewed, exactly like a rule column's code — same save,
// same approve, same hash pinned to the exact bytes. A predicate that decides what to spend money on
// is not a thing to run unread.

import { useEffect, useState } from "react";
import { Section } from "../ui/Section.tsx";
import { IconPlay } from "../ui/Icon.tsx";
import { AiSetup } from "./AiSetup.tsx";
import type { RefOption } from "./RefMenu.tsx";
import type { Column } from "../api.ts";
import "./RunSettings.css";

interface SavedScript {
  id: string;
  hash: string;
  code: string;
  intent?: string;
  runtime: string;
  approvedAt: string | null;
  version: number;
  hook: string;
}

interface Props {
  column: Column;
  /** Every other column on the sheet, for the "/" menu. */
  columns: Column[];
  refOptions: RefOption[];
  /** Whether this column's lane costs money per row — changes how loudly auto-run is framed. */
  paid: boolean;
  onSaved: () => void;
}

export function RunSettings({ column, columns, refOptions, paid, onSaved }: Props) {
  const [autoRun, setAutoRun] = useState(!!column.autoRun);
  /**
   * The ceiling on one firing, as typed. `""` means no ceiling.
   *
   * A string, like every other money box here, because `Number("")` is 0 and 0 is not what an empty
   * box means. Null and zero are different answers and the type has to keep them apart.
   */
  const [cap, setCap] = useState<string>(
    column.autoRunBudgetUsd == null ? "" : String(column.autoRunBudgetUsd),
  );
  /**
   * Ticking the box on a paid column opens this instead of saving.
   *
   * The switch is the moment somebody decides this column may spend without them, so it is also the
   * only moment they are guaranteed to be looking. Offering the ceiling here rather than leaving it
   * on the tab is the whole difference between a limit people have and a limit people could have.
   */
  const [arming, setArming] = useState(false);
  const [firing, setFiring] = useState<{ perRow: number; rows: number; unpriced: boolean } | null>(null);
  const [condition, setCondition] = useState<SavedScript | null>(null);
  const [intent, setIntent] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = async () => {
    try {
      const col = await fetch(`/api/columns/${column.id}`).then((r) => r.json());
      const pointer = col.column?.conditionScriptId;
      const res = await fetch(`/api/columns/${column.id}/scripts`).then((r) => r.json());
      const all = (res.scripts ?? []).filter((s: SavedScript) => s.hook === "condition");
      // The one in force, not the newest that exists. After the gate is taken off, the script row
      // stays as history — and treating it as current would make the screen say there is a gate
      // when the engine knows there is not.
      const current = pointer ? all.find((s: SavedScript) => String(s.id) === String(pointer)) ?? null : null;
      setCondition(current);
      // The code stays in the editor either way, so turning a gate off and back on does not mean
      // writing it again.
      const newest = current ?? all[0] ?? null;
      if (newest) { setCode(newest.code ?? ""); setIntent(newest.intent ?? ""); }
    } catch {
      setError("Could not load this column's run condition.");
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [column.id]);
  useEffect(() => { setAutoRun(!!column.autoRun); }, [column.autoRun]);
  // The ceiling follows the saved value the same way the switch does, so a save elsewhere (or an
  // undo) does not leave this box showing a number the engine is no longer using.
  useEffect(() => { setCap(column.autoRunBudgetUsd == null ? "" : String(column.autoRunBudgetUsd)); }, [column.autoRunBudgetUsd]);

  /**
   * Save the switch, and optionally the ceiling with it.
   *
   * Both in ONE request so they cannot half-land. Saving them separately leaves a window where the
   * column is armed with no ceiling, and `flush` reads the ceiling when it fires — a window that is
   * short in wall-clock terms and exactly long enough if an import is already in flight.
   */
  const saveAutoRun = async (on: boolean, budgetUsd?: number | null) => {
    const previous = autoRun;
    setAutoRun(on);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { autoRun: on };
      if (budgetUsd !== undefined) body.autoRunBudgetUsd = budgetUsd;
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (res.error) { setAutoRun(previous); setError(res.error); return; }
      setError(null);
      setArming(false);
      onSaved();
    } catch {
      setAutoRun(previous);
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * What one full pass over this table costs today, from the server's own figures.
   *
   * Asked rather than computed here: the price list, the token shape and the row count all live on
   * the engine, and a suggested ceiling worked out in the browser from a guessed per-row figure is
   * exactly the invented number this codebase keeps refusing to print. A model with no published
   * price returns `unpriced` and the panel says so instead of prefilling anything.
   */
  const priceOneFiring = async () => {
    try {
      const d = await fetch(`/api/columns/${column.id}/estimate-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json());
      if (!d?.pricedLane || d.error) { setFiring(null); return; }
      const rows = Number(d.sheetRows ?? 0);
      const perRow = Number(d.perRow ?? 0);
      setFiring({ perRow, rows, unpriced: !!d.unpriced });
      // Round up to something a person would type. A suggestion of $1.8734 reads as a measurement
      // and invites being accepted unread; $2 reads as a decision.
      if (!d.unpriced && perRow > 0 && rows > 0) {
        const suggested = Math.max(0.01, Math.ceil(perRow * rows * 100) / 100);
        setCap(String(suggested));
      }
    } catch {
      setFiring(null);
    }
  };

  const toggleAutoRun = async (on: boolean) => {
    // Turning it OFF is never worth a confirmation, and turning it on costs nothing on a free
    // column. Only arming a paid one stops to ask.
    if (!on || !paid) { await saveAutoRun(on); return; }
    setArming(true);
    setFiring(null);
    void priceOneFiring();
  };

  const saveCondition = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/columns/${column.id}/scripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook: "condition", runtime: "js", intent, code }),
      }).then((r) => r.json());
      // `error` is the route refusing outright — a column that has gone answers with it and with no
      // `errors` list at all, so reading only the list treated a refused save as a saved condition
      // and stored `undefined` as the script.
      if (res.error) { setError(String(res.error)); return; }
      if ((res.errors ?? []).length > 0) { setError(res.errors.join(" ")); return; }
      setCondition(res.script);
      onSaved();
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!condition) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/scripts/${condition.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash: condition.hash }),
      }).then((r) => r.json());
      if (res.error) setError(res.error);
      else { setCondition(res.script); onSaved(); }
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Take the gate off, without breaking the column.
   *
   * Not "revoke approval". Revoking leaves the column pointing at an unapproved condition, and the
   * engine refuses to run a column whose condition nobody approved — correctly, since silently
   * running ungated is how a gate that was meant to save money costs it. But that turns "turn this
   * off" into "this column now fails every run", which is not what the button says. So the pointer
   * is cleared and the code is kept, ready to be saved again.
   */
  const remove = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${column.id}/condition`, { method: "DELETE" }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setCondition(null);
      onSaved();
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const active = !!condition?.approvedAt;

  return (
    <div className="cc-runset">
      <div className={`cc-runset__gate${active ? " cc-runset__gate--on" : ""}`}>
        <div className="cc-runset__gatehead">
          <span className="cc-runset__gatelabel">Run condition</span>
          <span className={`cc-pill ${active ? "cc-pill--done" : condition ? "cc-pill--queued" : "cc-pill--idle"}`}>
            {active ? "Active" : condition ? "Needs review" : "None"}
          </span>
        </div>
        <p className="cc-runset__copy">
          {active
            ? "Rows that fail this are skipped with the reason shown, and never reach the paid part of the column."
            : condition
            ? "This condition is written but not approved, so the column will refuse to run until you read it and approve it. That is deliberate: a rule that decides what to spend money on does not run unread."
            : "A condition is checked on every row for free, before anything is spent. Without one, every row in the run costs whatever this column costs."}
        </p>
      </div>

      {/* ONE plain-English box, not two.

          One field, not the drawer's "Describe it and I'll set it up" panel AND a second field
          asking, in different words, for exactly the same sentence, with nothing to say which of
          them matters. What you type here is both what the model turns into a rule and what gets
          saved beside that rule, so it is still here next time.

          "This column", not "this row": the condition is checked once per row, but what it decides
          is whether THIS COLUMN spends anything on that row. */}
      <AiSetup
        columnId={column.id}
        area="condition"
        title="Which rows should this column run on?"
        sub="plain English — I'll turn it into a rule once"
        collapsible={false}
        columns={columns}
        refOptions={refOptions}
        value={intent}
        onValueChange={setIntent}
        placeholder="Only run this on companies in the US or Canada with more than 50 staff and a website"
        onApplied={() => { void reload(); onSaved(); }}
      />

      <label className="cc-field">
        <span className="cc-field__label">
          The rule
          <span className="cc-field__sub">reviewed before it can decide anything</span>
        </span>
        <textarea
          className="cc-code"
          rows={8}
          spellCheck={false}
          placeholder={"function condition(row) {\n  return row.country === 'US' && Number(row.employees) > 50;\n}"}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>

      {error && <div className="cc-errors" role="alert"><div className="cc-errors__row">{error}</div></div>}

      {/* Meta left, actions right — the strip spans its width rather than packing at one end. */}
      <div className="cc-runset__foot">
        <span className="cc-runset__meta mono">
          {condition ? `v${condition.version} · ${condition.hash.slice(0, 8)}` : loaded ? "no condition" : "loading…"}
        </span>
        <div className="cc-runset__actions">
          {condition && (
            <button className="cc-btn cc-btn--xs" onClick={() => void remove()} disabled={busy}>Turn off</button>
          )}
          <button className="cc-btn cc-btn--xs" onClick={() => void saveCondition()} disabled={busy || !code.trim()}>
            Save
          </button>
          {condition && !condition.approvedAt && (
            <button className="cc-btn cc-btn--primary cc-btn--xs" onClick={() => void approve()} disabled={busy}>
              <IconPlay /> <span>Approve</span>
            </button>
          )}
        </div>
      </div>

      <Section
        label="Run by itself"
        summary={autoRun ? (paid ? (cap ? `on · $${cap} limit` : "on · no limit") : "on") : "off"}
        defaultOpen={autoRun || arming}
      >
        <label className="cc-runset__check">
          <input type="checkbox" checked={autoRun} disabled={busy} onChange={(e) => void toggleAutoRun(e.target.checked)} />
          <span>
            Run this column when the values it depends on change
            <span className="cc-runset__checkhint">
              {paid
                ? "This column costs money on every row. Turning this on lets it fill new rows as they arrive, which is the reason most people want it. Give it a limit and it stops there instead of running on."
                : "This column is free to run, so there is no cost to letting it keep itself up to date."}
            </span>
          </span>
        </label>

        {/* ── the moment of consent ─────────────────────────────────────
            Not a modal. The decision belongs beside the switch that caused it, and a dialog over the
            top would hide the run condition directly above — which is the other half of the answer
            to "how do I stop this costing so much". */}
        {arming && (
          <div className="cc-runset__arm" role="group" aria-label="Set a limit before this column starts filling itself">
            <p className="cc-runset__armlead">
              {firing == null
                ? "Working out what one pass over this table costs…"
                : firing.unpriced
                  ? "This model has no published price, so Ferrum cannot suggest a limit. You can still set one."
                  : firing.rows === 0
                    // "$0.00" on an empty table reads as "this is free", which is the one impression
                    // this panel must not leave. Price the unit instead, since that is the only real
                    // number there is until rows arrive.
                    ? (
                      <>
                        This table has no rows yet, so there is nothing to add up. Each row will cost
                        about <strong>${firing.perRow.toFixed(4)}</strong> at today's prices.
                      </>
                    )
                    : (
                      <>
                        One pass over all {firing.rows.toLocaleString()} rows costs about{" "}
                        <strong>${(firing.perRow * firing.rows).toFixed(2)}</strong> at today's prices.
                        Rows that have not changed are skipped, so most passes cost far less.
                      </>
                    )}
            </p>
            <label className="cc-field">
              <span className="cc-field__label">
                Stop after
                <span className="cc-field__sub">US dollars, per firing</span>
              </span>
              <input
                className="cc-input cc-input--num"
                type="number"
                min={0}
                step="0.5"
                size={8}
                value={cap}
                autoFocus
                placeholder="no limit"
                aria-label="The most one firing of this column may spend, in dollars"
                onChange={(e) => setCap(e.target.value)}
              />
              <span className="cc-field__hint">
                Reaching it <strong>pauses</strong> that run. The rows already filled keep their
                values, and you can raise the limit and carry on.
              </span>
            </label>
            <div className="cc-runset__armacts">
              <button className="cc-btn" onClick={() => { setArming(false); setAutoRun(false); }} disabled={busy}>
                Cancel
              </button>
              {/* Reachable, and it says what it means. A limit nobody can decline is a limit people
                  route around; one they can decline in a labelled button is one they chose. */}
              <button className="cc-btn" onClick={() => { setCap(""); void saveAutoRun(true, null); }} disabled={busy}>
                No limit
              </button>
              <button
                className="cc-btn cc-btn--primary"
                onClick={() => void saveAutoRun(true, cap.trim() ? Number(cap) : null)}
                disabled={busy || (!!cap.trim() && !(Number(cap) > 0))}
              >
                Turn it on
              </button>
            </div>
          </div>
        )}

        {/* Once it is on, the ceiling stays visible and editable here rather than only in the
            summary line. A limit you have to re-arm the switch to change is one nobody adjusts. */}
        {autoRun && paid && !arming && (
          <label className="cc-field">
            <span className="cc-field__label">
              Stop after
              <span className="cc-field__sub">US dollars, per firing</span>
            </span>
            <input
              className="cc-input cc-input--num"
              type="number"
              min={0}
              step="0.5"
              size={8}
              value={cap}
              disabled={busy}
              placeholder="no limit"
              aria-label="The most one firing of this column may spend, in dollars"
              onChange={(e) => setCap(e.target.value)}
              onBlur={() => {
                const next = cap.trim() ? Number(cap) : null;
                if (next !== null && !(next > 0)) { setCap(column.autoRunBudgetUsd == null ? "" : String(column.autoRunBudgetUsd)); return; }
                if (next === (column.autoRunBudgetUsd ?? null)) return;
                void saveAutoRun(true, next);
              }}
            />
            <span className="cc-field__hint">
              {cap.trim()
                ? "Reaching it pauses that run. The rows already filled keep their values."
                : "No limit. This column will fill every row that changes, however many arrive."}
            </span>
          </label>
        )}

        {autoRun && !active && paid && !cap.trim() && (
          <div className="cc-mode__warn" role="status">
            <strong>No run condition and no limit.</strong> Every row whose upstream values change
            will be paid for, without anyone pressing anything. Add a condition above, set a limit,
            or turn this back off.
          </div>
        )}
      </Section>
    </div>
  );
}
