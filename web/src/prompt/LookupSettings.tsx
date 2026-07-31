// Where a lookup column reads from: which link, and which field across it.
//
// The screen is built around the number that decides whether this worked — how many of your rows
// actually found something. A link that reports only "connected" is the shape that lets someone
// build three columns on top of a join that matches 4% of their rows and find out a day later. So
// the health of every link is on screen before anything is chosen, and after every change.
//
// The other thing it has to do is make a link CREATABLE here. Sending someone to a separate screen
// to define a relationship before they can configure the column that needs it is how a feature ends
// up unused: the column is the moment you know what you want to match on.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Column, type MatchMode, type Relation, type RollupFn, type Sheet } from "../api.ts";
import { Select } from "../ui/Select.tsx";
import { IconAlert, IconCheck } from "../ui/Icon.tsx";
import "./LookupSettings.css";

interface Props {
  column: Column;
  columns: Column[];
  sheetId: string;
  /** Every table, so the linkable ones can be worked out here rather than faked by the caller. */
  sheets: Sheet[];
  onSaved: () => void;
}

/** Rows that found something, as a share of the rows that had anything to match with. */
const hitRate = (h: Relation["health"]): number =>
  h.keyed === 0 ? 0 : Math.round((h.matched / h.keyed) * 100);

export function LookupSettings({ column, columns, sheetId, sheets: allSheets, onSaved }: Props) {
  const sheet = allSheets.find((s) => s.id === sheetId) ?? null;
  const [relations, setRelations] = useState<Relation[] | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  /** Columns of the other table, fetched per link so the field picker can name them. */
  const [otherColumns, setOtherColumns] = useState<Column[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // The link being built, when there is not one yet.
  const [newTarget, setNewTarget] = useState<string>("");
  const [newHere, setNewHere] = useState<string>("");
  const [newThere, setNewThere] = useState<string>("");

  /**
   * The link being looked at, which is not the same as the link that is SAVED.
   *
   * They were the same, and it deadlocked: clicking a link tried to save it with no field yet, the
   * engine rightly refused ("no field chosen to read"), and the field picker only appeared once a
   * link was saved — so there was no order in which the two could be filled in. Selecting is now a
   * local step and the save happens when both halves exist.
   */
  const [picked, setPicked] = useState<number | null>(column.relationId ?? null);
  useEffect(() => { setPicked(column.relationId ?? null); }, [column.relationId]);

  const chosen = useMemo(
    () => relations?.find((r) => r.id === Number(picked)) ?? null,
    [relations, picked],
  );

  const load = useCallback(async () => {
    try {
      const [rels, all] = await Promise.all([api.relations(sheetId), api.listSheets()]);
      setRelations(rels.relations);
      // Only tables in the same workbook can be linked, so offering the rest would be offering
      // choices the engine refuses.
      setSheets(all.sheets.filter((s) => s.id !== sheetId && s.workbookId === (sheet?.workbookId ?? null)));
      setError(null);
    } catch {
      setError("Could not read this table's links.");
    }
  }, [sheetId, sheet?.workbookId]);

  useEffect(() => { void load(); }, [load]);

  // The other table's columns, so "which field do I want" is a list of names rather than an id.
  useEffect(() => {
    if (!chosen) { setOtherColumns([]); return; }
    let cancelled = false;
    void api.getSheet(chosen.otherSheetId)
      .then((r) => { if (!cancelled) setOtherColumns(r.columns); })
      .catch(() => { if (!cancelled) setOtherColumns([]); });
    return () => { cancelled = true; };
  }, [chosen?.otherSheetId]);

  const useRelation = async (relationId: number, sourceColumnId: number) => {
    setBusy(true); setError(null); setNote(null);
    try {
      await api.setLookup(column.id, relationId, sourceColumnId);
      setNote("Saved. Run the column to fill it in.");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that.");
    } finally { setBusy(false); }
  };

  const createLink = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const { relation } = await api.createRelation({
        fromSheetId: sheetId,
        fromColumnId: Number(newHere),
        toSheetId: newTarget,
        toColumnId: Number(newThere),
      });
      await load();
      setPicked(relation.id);
      // The health comes back with the link, so the answer to "did that work" is immediate rather
      // than something to go and check.
      const rate = hitRate(relation.health);
      setNote(
        relation.health.keyed === 0
          ? "Linked — but nothing in that column has a value yet, so there is nothing to match on."
          : `Linked. ${relation.health.matched.toLocaleString()} of ${relation.health.keyed.toLocaleString()} rows found a match (${rate}%).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create that link.");
    } finally { setBusy(false); }
  };

  /**
   * Loosen or tighten a link.
   *
   * The new match rate is reported straight back, because that is the entire question being asked:
   * does relaxing this find more of my rows? Leaving the user to go and check turns a measurable
   * choice into a guess.
   */
  const changeMode = async (id: number, matchMode: MatchMode) => {
    setBusy(true); setError(null); setNote(null);
    try {
      const { health } = await api.setMatchMode(id, matchMode);
      await load();
      setNote(
        health.keyed === 0
          ? "Saved — there is still nothing in that column to match on."
          : `Now matching ${health.matched.toLocaleString()} of ${health.keyed.toLocaleString()} rows (${hitRate(health)}%).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change how this link matches.");
    } finally { setBusy(false); }
  };

  /**
   * A rollup and a lookup share this whole screen except for the last step.
   *
   * They ask the same two questions — which link, and what on the other side — and differ only in
   * whether the answer is one row's value or a calculation over all of them. Two near-identical
   * panels would drift, and the half that drifted would be the link-health half, which is the part
   * that matters.
   */
  const isRollup = column.kind === "rollup";

  /**
   * The calculation being CHOSEN, which is not always the one saved.
   *
   * Same trap as picking a link, in a second place: switching from "how many" to "average" saved
   * immediately with no field yet, the engine rightly refused, and because the save failed the
   * column stayed on "how many" — so the field picker never appeared and average was unreachable.
   * Everything except `count` needs a field, so the choice is held here and written once it is
   * complete.
   */
  const [pendingFn, setPendingFn] = useState<RollupFn | null>(null);
  useEffect(() => { setPendingFn(null); }, [column.rollup?.fn]);
  const fn: RollupFn = pendingFn ?? (column.rollup?.fn as RollupFn) ?? "count";

  const saveRollup = async (relationId: number, next: RollupFn, sourceColumnId: number | null) => {
    setBusy(true); setError(null); setNote(null);
    try {
      await api.setRollup(column.id, relationId, next, sourceColumnId);
      setNote("Saved. Run the column to fill it in.");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that calculation.");
    } finally { setBusy(false); }
  };

  const rebuild = async (id: number) => {
    setBusy(true); setError(null); setNote(null);
    try {
      const { health } = await api.rebuildRelation(id);
      await load();
      setNote(`Re-checked. ${health.matched.toLocaleString()} of ${health.keyed.toLocaleString()} rows match.`);
    } catch {
      setError("Could not re-check that link.");
    } finally { setBusy(false); }
  };

  // Any column of this table can be the key except the lookup itself — a column matching on its own
  // value would be reading through a link it is the output of.
  const keyColumns = columns.filter((c) => Number(c.id) !== Number(column.id));

  return (
    <div className="cc-lk">
      {relations && relations.length > 0 && (
        <section className="cc-lk__sec">
          <h3 className="cc-lk__title">Which link to read through</h3>
          <ul className="cc-lk__links">
            {relations.map((r) => {
              const on = r.id === Number(picked);
              const rate = hitRate(r.health);
              return (
                <li key={r.id} className={`cc-lk__link${on ? " cc-lk__link--on" : ""}`}>
                  <button
                    className="cc-lk__pick"
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => {
                      setPicked(r.id);
                      setError(null);
                      setNote(null);
                      // Only saves when there is already a field AND this is the link that field
                      // belongs to. Otherwise picking the link just reveals the field picker, which
                      // is the next thing to answer.
                      const keep = Number(column.lookupColumnId);
                      // A rollup can be saved the moment a link is picked, because `count` needs no
                      // field — so choosing a link is already a complete configuration.
                      if (isRollup) void saveRollup(r.id, fn, fn === "count" ? null : (keep > 0 ? keep : null));
                      else if (on && Number.isFinite(keep) && keep > 0) void useRelation(r.id, keep);
                    }}
                  >
                    <span className="cc-lk__linkname">{r.otherSheetName}</span>
                    <span className="cc-lk__linksub">
                      matched on this table's{" "}
                      <strong>{columns.find((c) => Number(c.id) === r.fromColumnId)?.name ?? "a column"}</strong>
                    </span>
                  </button>

                  {/* The number that decides whether this link is worth building on. Stated as a
                      share AND as counts: 96% of a hundred keyed rows out of two thousand is not a
                      good link, and only the counts say so. */}
                  <div className="cc-lk__health">
                    <span className={`cc-lk__rate${rate >= 80 ? " cc-lk__rate--good" : rate >= 40 ? " cc-lk__rate--ok" : " cc-lk__rate--bad"}`}>
                      {r.health.keyed === 0 ? "nothing to match on" : `${rate}% matched`}
                    </span>
                    <span className="cc-lk__counts mono">
                      {r.health.matched.toLocaleString()} matched · {r.health.unmatched.toLocaleString()} not found
                      {r.health.blank > 0 && <> · {r.health.blank.toLocaleString()} blank</>}
                    </span>
                    {/* Reported because it is the failure that looks like success: the column still
                        fills in, it just picks one of several. */}
                    {r.health.ambiguous > 0 && (
                      <span className="cc-lk__warn">
                        <IconAlert />
                        {r.health.ambiguous.toLocaleString()} of these match more than one row over
                        there, so the value comes from whichever it finds first. Deduplicate{" "}
                        {r.otherSheetName} to make it exact.
                      </span>
                    )}
                    <button className="cc-btn cc-btn--sm" disabled={busy} onClick={() => void rebuild(r.id)}>
                      Re-check
                    </button>

                    {/* How strictly it matches, beside the number that shows the effect. Putting the
                        control anywhere else would mean changing it and going to look for the
                        result; here, loosening it and watching the count move is one glance. */}
                    <div className="cc-lk__mode">
                      <Select
                        label="How strictly to match"
                        value={r.matchMode}
                        showLabel={false}
                        size="sm"
                        options={[
                          { value: "exact", label: "Exactly", hint: "strict" },
                          { value: "normalized", label: "Ignoring case and formatting", hint: "usual" },
                          { value: "fuzzy", label: "Ignoring Ltd, Inc and word order", hint: "loose" },
                        ]}
                        onChange={(v) => void changeMode(r.id, v as MatchMode)}
                      />
                    </div>
                    {/* Each mode described by the mistake it makes, because that is what you are
                        choosing between. "Smarter" tells you nothing about which to pick. */}
                    <span className="cc-lk__modehint">
                      {r.matchMode === "exact"
                        ? "Character for character. Nothing wrong will match — and “Acme.com” will not find “acme.com”."
                        : r.matchMode === "normalized"
                          ? "“https://www.Acme.com/” finds “acme.com”. “Acme Inc.” does not find “Acme”."
                          : "“Acme Inc.”, “ACME, Incorporated” and “Acme” all match. Watch the count above — this can also join two different companies that share a name."}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {chosen && isRollup && (
        <section className="cc-lk__sec">
          <h3 className="cc-lk__title">What to calculate</h3>
          <div className="cc-lk__row">
            <div className="cc-lk__field">
              <span className="cc-lk__label">Calculation</span>
              <Select
                label="Calculation"
                value={fn}
                showLabel={false}
                size="md"
                options={[
                  { value: "count", label: "How many rows", hint: "no field needed" },
                  { value: "sum", label: "Total" },
                  { value: "avg", label: "Average" },
                  { value: "min", label: "Smallest" },
                  { value: "max", label: "Largest" },
                  { value: "list", label: "All the values, joined" },
                ]}
                onChange={(v) => {
                  const next = v as RollupFn;
                  setPendingFn(next);
                  setError(null);
                  setNote(null);
                  // `count` is complete on its own. Everything else waits for a field — and if one
                  // is already chosen from a previous calculation, it is reused rather than asked
                  // for again.
                  const keep = Number(column.lookupColumnId);
                  if (next === "count") void saveRollup(chosen.id, next, null);
                  else if (keep > 0) void saveRollup(chosen.id, next, keep);
                }}
              />
            </div>

            {/* Count is about the ROWS, so asking which field would be a question with no meaning.
                Hiding it is the honest shape: an inert control still reads as something to fill in. */}
            {fn !== "count" && (
              <div className="cc-lk__field">
                <span className="cc-lk__label">Of which field</span>
                <Select
                  label="Field to calculate on"
                  value={String(column.lookupColumnId ?? "")}
                  showLabel={false}
                  size="md"
                  options={[
                    { value: "", label: "Pick a field…" },
                    ...otherColumns
                      .filter((c) => Number(c.id) !== chosen.toColumnId)
                      .map((c) => ({ value: String(c.id), label: c.name, hint: c.valueType })),
                  ]}
                  onChange={(v) => { if (v) void saveRollup(chosen.id, fn, Number(v)); }}
                />
              </div>
            )}
          </div>
          <p className="cc-lk__hint">
            {fn === "count" ? "Counting" : fn === "list" ? "Joining values from" : "Calculated over"}{" "}
            rows in <strong>{chosen.otherSheetName}</strong> that point at this one. Free however
            many rows you run it over.{" "}
            {fn === "count"
              ? "A row with none over there gets 0 — that is an answer, not a blank."
              : fn === "sum"
                ? "Values that are not numbers are left out rather than counted as zero, so one “unknown” cannot make a total too low."
                : fn === "avg"
                  ? "Averaged over the values that ARE numbers, so a stray “unknown” cannot drag it down."
                  : fn === "list"
                    ? "Joined with a comma. A row with none over there has no list rather than an empty one."
                    : "Compared as numbers, so 9 does not come after 10. A row with none over there has no answer rather than zero."}
          </p>
        </section>
      )}

      {chosen && !isRollup && (
        <section className="cc-lk__sec">
          <h3 className="cc-lk__title">Which field to bring across</h3>
          <div className="cc-lk__field">
            <Select
              label="Field to read"
              value={String(column.lookupColumnId ?? "")}
              showLabel={false}
              size="md"
              options={[
                { value: "", label: "Pick a field…" },
                ...otherColumns
                  .filter((c) => Number(c.id) !== chosen.toColumnId)
                  .map((c) => ({ value: String(c.id), label: c.name, hint: c.valueType })),
              ]}
              onChange={(v) => { if (v) void useRelation(chosen.id, Number(v)); }}
            />
          </div>
          <p className="cc-lk__hint">
            Reading from <strong>{chosen.otherSheetName}</strong>. This costs nothing however many
            rows you run it over, and it stays current: change the value over there and the rows
            reading it are marked out of date.
          </p>
        </section>
      )}

      {/* Creating a link lives HERE rather than on a separate screen. The column is the moment
          someone knows what they want to match on; sending them elsewhere first is how a feature
          goes unused. */}
      <section className="cc-lk__sec">
        <h3 className="cc-lk__title">{relations?.length ? "Or link another table" : "Link a table"}</h3>
        {sheets.length === 0 ? (
          <p className="cc-lk__hint">
            There is no other table in this workbook to link to yet. Add one to the tab bar at the
            bottom, and it can be matched against this one.
          </p>
        ) : (
          <>
            <div className="cc-lk__row">
              <div className="cc-lk__field">
                <span className="cc-lk__label">Table to read from</span>
                <Select
                  label="Table to read from"
                  value={newTarget}
                  showLabel={false}
                  size="md"
                  options={[{ value: "", label: "Pick a table…" }, ...sheets.map((s) => ({ value: s.id, label: s.name }))]}
                  onChange={(v) => { setNewTarget(v); setNewThere(""); }}
                />
              </div>
              <div className="cc-lk__field">
                <span className="cc-lk__label">Match this table's…</span>
                <Select
                  label="Column on this table"
                  value={newHere}
                  showLabel={false}
                  size="md"
                  options={[{ value: "", label: "Pick a column…" }, ...keyColumns.map((c) => ({ value: String(c.id), label: c.name, hint: c.valueType }))]}
                  onChange={setNewHere}
                />
              </div>
              <div className="cc-lk__field">
                <span className="cc-lk__label">…against their</span>
                <TargetColumnPicker sheetId={newTarget} value={newThere} onChange={setNewThere} />
              </div>
            </div>
            <p className="cc-lk__hint">
              Different spellings of the same thing still match, so “https://www.Acme.com/” finds
              “acme.com” and “GLOBEX.com” finds “globex.com”. Blank values never match each other.
            </p>
            <button
              className="cc-btn cc-btn--primary"
              disabled={busy || !newTarget || !newHere || !newThere}
              onClick={() => void createLink()}
            >
              {busy ? "Checking…" : "Link them"}
            </button>
          </>
        )}
      </section>

      {/* One reserved strip for both, so neither appearing can move the buttons above it. */}
      <div className="cc-lk__msg" role="status" aria-live="polite">
        {error && <span className="cc-lk__err"><IconAlert /> {error}</span>}
        {!error && note && <span className="cc-lk__ok"><IconCheck /> {note}</span>}
      </div>
    </div>
  );
}

/**
 * The other table's columns, loaded on demand.
 *
 * Its own component so picking a table does not re-render the whole panel while its columns arrive,
 * and so the empty state — a table with no columns yet — is a real state rather than a silent gap.
 */
function TargetColumnPicker({ sheetId, value, onChange }: { sheetId: string; value: string; onChange: (v: string) => void }) {
  const [cols, setCols] = useState<Column[] | null>(null);

  useEffect(() => {
    if (!sheetId) { setCols(null); return; }
    let cancelled = false;
    void api.getSheet(sheetId)
      .then((r) => { if (!cancelled) setCols(r.columns); })
      .catch(() => { if (!cancelled) setCols([]); });
    return () => { cancelled = true; };
  }, [sheetId]);

  return (
    <Select
      label="Column on the other table"
      value={value}
      showLabel={false}
      size="md"
      options={[
        { value: "", label: !sheetId ? "Pick a table first" : cols == null ? "Loading…" : cols.length === 0 ? "That table has no columns" : "Pick a column…" },
        ...(cols ?? []).map((c) => ({ value: String(c.id), label: c.name, hint: c.valueType })),
      ]}
      onChange={onChange}
    />
  );
}
