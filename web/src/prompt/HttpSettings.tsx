// The request an HTTP column makes.
//
// Two shapes share this screen: calling an API and keeping an answer, and sending a row somewhere
// and keeping only whether it arrived. They are the same request with a different question asked of
// the response, so they are one form with one switch rather than two screens that drift apart.
//
// Everything here saves itself rather than sitting behind a Save button: this drawer's Save belongs
// to the generated script, and a second Save meaning something else in the same footer is how a user
// ends up believing they saved one thing when they saved the other.
//
// ── Why query parameters and body fields are FIELDS ──────────────────────────────────────────────
// Typing `?domain=/Website&key=abc` into the address works, and it is also how a company name
// containing an ampersand silently ends one parameter and starts another. As named fields each one
// is escaped for where it lands, can be dropped when it renders empty, and — for a JSON body — is
// assembled into an object rather than spliced into text, so a cell containing `","admin":true`
// cannot add a field to the request.

import { useCallback, useEffect, useRef, useState } from "react";
import { Select } from "../ui/Select.tsx";
import { DestinationPicker } from "./DestinationPicker.tsx";
import { applyDestination } from "./destinations.ts";
import { useAutosave } from "../ui/useAutosave.ts";
import { Section } from "../ui/Section.tsx";
import { RefField } from "./RefField.tsx";
import type { RefOption } from "./RefMenu.tsx";
import { IconPlus } from "../ui/Icon.tsx";
import type { Column } from "../api.ts";
import "./HttpSettings.css";

export type { Pair, BodyMode, HttpCost, HttpConfig } from "./httpConfig.ts";
export { DEFAULT_HTTP } from "./httpConfig.ts";
import type { Pair, BodyMode, HttpCost, HttpConfig } from "./httpConfig.ts";
import { DEFAULT_HTTP } from "./httpConfig.ts";



const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }));

const BODY_MODES: Array<{ value: BodyMode; label: string; hint: string }> = [
  { value: "none", label: "None", hint: "No body is sent." },
  { value: "json", label: "JSON fields", hint: "Fields are assembled into a JSON object. A row value always lands as one string in one field." },
  { value: "form", label: "Form fields", hint: "Sent as a form post — name=value pairs, the shape an HTML form uses." },
  { value: "raw", label: "Written out", hint: "You write the body yourself. Use this only when the shape cannot be expressed as fields." },
];

/**
 * Mirrors hostIsFixed on the server. Used only to explain the checkbox, never to enforce.
 *
 * An EMPTY or half-typed address counts as fixed. The server only refuses the combination once
 * there is an address with a reference in its host — and blocking the checkbox before anything has
 * been typed would greet the user with "unavailable because the address comes from a column" about
 * an address that does not exist yet.
 */
function hostIsFixed(url: string): boolean {
  if (!url.trim()) return true;
  const m = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/);
  // Still being typed ("https:/", "htt") — no authority to judge yet, so do not accuse it of one.
  if (!m) return true;
  return !/\{\{/.test(m[1] ?? "");
}

const count = (n: number, one: string, many = `${one}s`) => (n === 0 ? "none" : `${n} ${n === 1 ? one : many}`);

const EMPTY_COST: HttpCost = { unit: "", perCall: 0, packUnits: 0, packUsd: 0 };

/** Mirrors callCost on the server, so the number under the fields is the number that gets recorded. */
function perCallUsd(c: HttpCost): number {
  if (!(c.perCall > 0) || !(c.packUnits > 0) || !(c.packUsd >= 0)) return 0;
  return (c.packUsd / c.packUnits) * c.perCall;
}

/**
 * A per-call price is often a fraction of a cent, and `$0.00` is the one thing it must never read as
 * — that is the exact wrong answer this whole feature exists to replace. So the number keeps
 * significant digits until it is genuinely zero.
 */
function money(usd: number): string {
  if (usd === 0) return "$0";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
  return `$${usd.toPrecision(2)}`;
}

/** A number field that can be genuinely empty while being typed, rather than snapping back to 0. */
function NumField(
  { value, onChange, disabled, step, placeholder }:
  { value: number; onChange: (n: number) => void; disabled?: boolean; step?: number; placeholder?: string },
) {
  return (
    <input
      className="cc-input cc-input--num"
      type="number"
      min={0}
      step={step ?? 1}
      size={6}
      placeholder={placeholder}
      value={value > 0 ? String(value) : ""}
      disabled={disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(Number.isFinite(n) && n > 0 ? n : 0);
      }}
    />
  );
}

interface Props {
  column: Column;
  columns: Column[];
  /** Columns offered by the "/" menu, with their sample values. */
  refOptions: RefOption[];
  value: HttpConfig;
  onChange: (next: HttpConfig) => void;
  error?: string | null;
  busy?: boolean;
}

export function HttpSettings({ column, columns, refOptions, value, onChange, error, busy }: Props) {
  const [local, setLocal] = useState(value);

  /**
   * What this form last sent upward.
   *
   * The parent re-seeds `value` from what the server saved, and the server drops a parameter or
   * header whose name is still blank — which is exactly what a row is one keystroke after you add
   * it. Echoing that back wiped every new row the instant it appeared, so Add parameter and Add
   * header did nothing at all. Only a value the form did NOT produce is treated as an outside
   * change worth adopting.
   */
  const mine = useRef(JSON.stringify(value));

  /**
   * The current form value, readable synchronously.
   *
   * `local` in a callback is whatever it was at the last render, and two edits can land between
   * renders — typing into a field and immediately ticking a box. Building the second patch on a
   * stale base silently discards the first.
   */
  const latest = useRef(local);

  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming === mine.current) return;
    mine.current = incoming;
    latest.current = value;
    setLocal(value);
  }, [value]);

  const autosave = useAutosave<HttpConfig>(
    useCallback((next: HttpConfig) => { mine.current = JSON.stringify(next); onChange(next); }, [onChange]),
  );

  const apply = (patch: Partial<HttpConfig>): HttpConfig => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setLocal(next);
    return next;
  };

  /** Used while typing. Saves once the typing settles, so no PATCH goes out per character. */
  const edit = (patch: Partial<HttpConfig>) => autosave.schedule(apply(patch));

  /**
   * Local AND saved, immediately.
   *
   * Used by checkboxes, segments, selects and add/remove, where the change is complete the moment it
   * happens and there is nothing to wait for.
   */
  const set = (patch: Partial<HttpConfig>) => {
    const next = apply(patch);
    autosave.markSaved(next);
    mine.current = JSON.stringify(next);
    onChange(next);
  };

  /** Flush early. Bound to blur on every text field, so leaving a field saves it at once. */
  const commit = autosave.flush;

  /**
   * A stable key per pair row, held here rather than in the saved config.
   *
   * These were keyed by array index, and every row has its own delete button: removing the second of
   * three handed row 2's key to what had been row 3, so React reused the element and the focus ring
   * — and any open reference menu — stayed put while a DIFFERENT parameter slid under it. The key
   * cannot live on the pair itself because the server stores `{name, value}` and drops anything
   * else, so identity is assigned on arrival and spliced along with the row it belongs to.
   */
  const rowKeys = useRef<Record<"query" | "headers" | "bodyFields", number[]>>({ query: [], headers: [], bodyFields: [] });
  const nextRowKey = useRef(1);
  const keysFor = (key: "query" | "headers" | "bodyFields", n: number): number[] => {
    const a = rowKeys.current[key];
    while (a.length < n) a.push(nextRowKey.current++);
    if (a.length > n) a.length = n;
    return a;
  };

  const others = columns.filter((c) => c.id !== column.id);
  const fixedHost = hostIsFixed(local.url);
  const canHaveBody = local.method !== "GET";
  const structured = local.bodyMode === "json" || local.bodyMode === "form";

  /** One editor shape for query parameters, headers and body fields — they are the same control. */
  const pairEditor = (
    key: "query" | "headers" | "bodyFields",
    namePlaceholder: string,
    valuePlaceholder: string,
    addLabel: string,
  ) => {
    const rows = local[key];
    const keys = keysFor(key, rows.length);
    return (
      <div className="cc-http__pairs">
        {rows.map((p, i) => (
          <div key={keys[i]} className="cc-http__prow">
            <input
              className="cc-input cc-http__pname"
              value={p.name}
              placeholder={namePlaceholder}
              aria-label={`${addLabel} name`}
              spellCheck={false}
              onChange={(e) => edit({ [key]: rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) } as never)}
              onBlur={commit}
            />
            <RefField
              className="cc-input cc-http__pval"
              value={p.value}
              placeholder={valuePlaceholder}
              ariaLabel={`${addLabel} value`}
              columns={columns}
              options={refOptions}
              onChange={(v) => edit({ [key]: rows.map((x, j) => (j === i ? { ...x, value: v } : x)) } as never)}
              onBlur={commit}
              showChips={key !== "headers"}
            />
            <button
              className="hk-icon-btn"
              onClick={() => {
                // The key goes with the row, so the rows below keep the elements they already had.
                rowKeys.current[key].splice(i, 1);
                set({ [key]: rows.filter((_, j) => j !== i) } as never);
              }}
              aria-label={`Remove this ${addLabel.toLowerCase()}`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        ))}
        <button
          className="cc-btn cc-btn--ghost cc-btn--xs"
          onClick={() => set({ [key]: [...rows, { name: "", value: "" }] } as never)}
        >
          <IconPlus /> <span>{addLabel}</span>
        </button>
      </div>
    );
  };

  return (
    <div className="cc-http">
      {/* A starting point, not an integration.
      
          It writes the same config a person would have typed, into these same fields, and every one
          of them stays editable. That is deliberate: the day a provider moves an endpoint, a form
          you can edit is a two-second fix where a black box is a support ticket. It is also why the
          picker says when each was written down — these come from public docs, not from a live call
          against every provider, and a preset that is quietly out of date is worse than none. */}
      <DestinationPicker
        onPick={(d) => {
          const next = applyDestination(latest.current, d);
          setLocal(next);
          latest.current = next;
          onChange(next);
          mine.current = JSON.stringify(next);
        }}
        disabled={busy}
      />

      <p className="cc-http__intro">
        Type <kbd>/</kbd> in any box below to drop in another column's value for this row. Values are
        escaped for wherever they land, so a name with an <code>&amp;</code> or a quote in it cannot
        break the request. Need a literal slash in a web address? Two of them — <code>//</code>.
      </p>

      <div className="cc-field">
        <span className="cc-field__label">Address</span>
        <div className="cc-http__line">
          <Select
            label="Method"
            value={local.method}
            options={METHODS}
            size="sm"
            showLabel={false}
            onChange={(v) => set({ method: v })}
          />
          <RefField
            className="cc-input cc-http__url"
            value={local.url}
            placeholder="https://api.example.com/lookup"
            ariaLabel="Web address"
            columns={columns}
            options={refOptions}
            onChange={(v) => edit({ url: v })}
            onBlur={commit}
            showChips
          />
        </div>
        {/* Was a list of every column's name printed under the field, because a reference was TEXT
            and had to be spelled correctly. A reference is now inserted from a menu and drawn as a
            chip, so there is no spelling to get right and nothing to look up. */}
        {others.length > 0 && (
          <span className="cc-field__hint">Type / to put a column in.</span>
        )}
      </div>

      <Section label="Query parameters" summary={count(local.query.length, "parameter")} defaultOpen={local.query.length > 0}>
        <p className="cc-http__hint">
          Added after the <code>?</code> in the address. Each one is encoded on its own, so a value
          containing <code>&amp;</code> or <code>=</code> stays inside its own parameter.
        </p>
        {pairEditor("query", "domain", "/Website", "Parameter")}
      </Section>

      <Section label="Headers" summary={count(local.headers.length, "header")} defaultOpen={local.headers.length > 0}>
        <p className="cc-http__hint">Where an API key goes. Usually <code>Authorization</code> with a value like <code>Bearer …</code>.</p>
        {pairEditor("headers", "Authorization", "Bearer …", "Header")}
      </Section>

      <Section
        label="Body"
        summary={!canHaveBody ? "not sent on GET" : local.bodyMode === "none" ? "none"
          : structured ? count(local.bodyFields.length, "field") : "written out"}
        defaultOpen={canHaveBody && local.bodyMode !== "none"}
      >
        {!canHaveBody ? (
          <p className="cc-http__hint">
            A GET request has no body. Switch the method above to POST if you need to send data.
          </p>
        ) : (
          <>
            <div className="cc-seg cc-seg--wrap">
              {BODY_MODES.map((m) => (
                <button
                  key={m.value}
                  className={`cc-seg__btn${local.bodyMode === m.value ? " cc-seg__btn--on" : ""}`}
                  onClick={() => set({ bodyMode: m.value })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="cc-http__hint">{BODY_MODES.find((m) => m.value === local.bodyMode)?.hint}</p>

            {structured && pairEditor("bodyFields", "company", "/Company", "Field")}

            {local.bodyMode === "raw" && (
              <RefField
                className="cc-textarea cc-textarea--sm cc-mono"
                rows={6}
                placeholder={'{\n  "company": "/Company",\n  "website": "/Website"\n}'}
                value={local.body}
                ariaLabel="Body"
                columns={columns}
                options={refOptions}
                onChange={(v) => edit({ body: v })}
                onBlur={commit}
                showChips
              />
            )}
          </>
        )}
      </Section>

      <div className="cc-field">
        <span className="cc-field__label">What to keep from the reply</span>
        <div className="cc-seg">
          <button
            className={`cc-seg__btn${!local.fireAndForget ? " cc-seg__btn--on" : ""}`}
            onClick={() => set({ fireAndForget: false })}
          >
            A value
          </button>
          <button
            className={`cc-seg__btn${local.fireAndForget ? " cc-seg__btn--on" : ""}`}
            onClick={() => set({ fireAndForget: true })}
          >
            Just whether it worked
          </button>
        </div>
        <span className="cc-field__hint">
          {local.fireAndForget
            ? "The cell records that it was sent. This is what you want for pushing rows to another system."
            : "The cell holds a value from the reply. Say which field below, or leave it blank to keep the whole reply."}
        </span>
      </div>

      {!local.fireAndForget && (
        <label className="cc-field">
          <span className="cc-field__label">Field to keep</span>
          <input
            className="cc-input cc-mono"
            value={local.responsePath}
            placeholder="data.company.name"
            aria-label="Field to keep"
            spellCheck={false}
            onChange={(e) => edit({ responsePath: e.target.value })}
            onBlur={commit}
          />
          <span className="cc-field__hint">
            A dotted path into the reply. Leave empty to keep the whole thing — useful once, then
            expand it into columns from the column menu.
          </span>
        </label>
      )}

      <Section
        label="When it goes wrong"
        summary={local.retryOnFailure ? `retries ${local.maxRetries}×` : "no retries"}
      >
        <label className="cc-http__check">
          <input
            type="checkbox"
            checked={local.retryOnFailure}
            disabled={busy}
            onChange={(e) => set({ retryOnFailure: e.target.checked })}
          />
          <span>
            Try again if it fails
            <span className="cc-http__checkhint">
              Only for the kinds of failure worth repeating — rate limits and a server that is briefly
              unwell. A rejected request is not retried, because it would be rejected again.
              {local.fireAndForget ? " Careful with this one: if the thing you are calling creates a record, a retry can create it twice." : ""}
            </span>
          </span>
        </label>

        {local.retryOnFailure && (
          <label className="cc-field cc-field--tight">
            <span className="cc-field__label">How many extra tries</span>
            <input
              className="cc-input cc-input--num"
              type="number"
              min={0}
              max={5}
              size={4}
              value={local.maxRetries}
              disabled={busy}
              onChange={(e) => set({ maxRetries: Math.max(0, Math.min(5, Math.floor(Number(e.target.value) || 0))) })}
            />
            <span className="cc-field__hint">
              This multiplies against every row. Two extra tries on a million-row sheet is up to three
              million requests, and on a metered API that is three times the bill.
            </span>
          </label>
        )}

        <label className="cc-field cc-field--tight">
          <span className="cc-field__label">Give up after</span>
          <div className="cc-http__inline">
            <input
              className="cc-input cc-input--num"
              type="number"
              min={1}
              max={120}
              size={4}
              value={Math.round(local.timeoutMs / 1000)}
              disabled={busy}
              onChange={(e) => set({ timeoutMs: Math.max(1, Math.min(120, Math.floor(Number(e.target.value) || 20))) * 1000 })}
            />
            <span className="cc-http__unit">seconds</span>
          </div>
        </label>
      </Section>

      {(() => {
        const cost = local.cost ?? EMPTY_COST;
        const setCost = (patch: Partial<HttpCost>) => set({ cost: { ...cost, ...patch } });
        const each = perCallUsd(cost);
        const unit = cost.unit.trim();
        return (
          <Section
            label="What this costs"
            summary={
              cost.perCall > 0
                ? [
                    `${cost.perCall} ${unit || "unit"}${cost.perCall === 1 ? "" : "s"} a call`,
                    each > 0 ? `${money(each)} each` : null,
                  ].filter(Boolean).join(" · ")
                : "not set"
            }
            // Opens only when it has been filled in. A column that has never been priced should not
            // greet everyone with four empty boxes about money.
            defaultOpen={cost.perCall > 0}
          >
            <p className="cc-http__costnote">
              Optional. Nothing here changes the request — it is only how the workspace prices it.
              Without it a table calling a paid service reports $0, which reads as free.
            </p>

            <div className="cc-http__cost">
              {/* A div, not a label: a label wrapping more than one control forwards every click in
                  its box to the first one, so clicking near the price would focus the count. */}
              <div className="cc-field cc-field--tight">
                <span className="cc-field__label">One call uses</span>
                <div className="cc-http__inline">
                  <NumField value={cost.perCall} disabled={busy} placeholder="1" onChange={(n) => setCost({ perCall: n })} />
                  <input
                    className="cc-input cc-input--unit"
                    type="text"
                    value={cost.unit}
                    placeholder="credits"
                    disabled={busy}
                    onChange={(e) => setCost({ unit: e.target.value })}
                  />
                </div>
              </div>

              <div className="cc-field cc-field--tight">
                <span className="cc-field__label">You buy</span>
                <div className="cc-http__inline">
                  <NumField value={cost.packUnits} disabled={busy} placeholder="1000" onChange={(n) => setCost({ packUnits: n })} />
                  <span className="cc-http__unit">{unit || "units"} for</span>
                  <span className="cc-http__unit">$</span>
                  <NumField value={cost.packUsd} step={0.01} disabled={busy} placeholder="49" onChange={(n) => setCost({ packUsd: n })} />
                </div>
              </div>
            </div>

            {/* The whole point, stated back: what one row costs and what the sheet would cost. Left
                out, the four boxes above are arithmetic homework. */}
            {cost.perCall > 0 && (
              <div className="cc-http__costout">
                <span className="cc-http__costout__k">Each row</span>
                <span className="cc-http__costout__v">
                  {cost.perCall} {unit || "unit"}{cost.perCall === 1 ? "" : "s"}
                  {each > 0 ? ` · ${money(each)}` : ""}
                </span>
              </div>
            )}
            {cost.perCall > 0 && each === 0 && (
              <p className="cc-http__costnote">
                Counting {unit || "units"} but not money — fill in what a bundle costs to see a price.
              </p>
            )}
          </Section>
        );
      })()}

      <Section
        label="Advanced"
        summary={[
          local.removeEmpty ? "drops empty" : null,
          local.returnMetadata ? "keeps status" : null,
          local.followRedirects ? "follows redirects" : "no redirects",
          // The one security-relevant switch in this section, so it belongs in the line you read
          // WITHOUT opening it. Left out, a column pointed at an internal address could be reviewed
          // by someone who never saw that it was allowed to reach one.
          local.allowPrivate ? "private addresses allowed" : null,
        ].filter(Boolean).join(" · ")}
        // And the section starts open when it is set, so the review cannot miss it either.
        defaultOpen={local.allowPrivate}
      >
        <label className="cc-http__check">
          <input type="checkbox" checked={local.removeEmpty} disabled={busy} onChange={(e) => set({ removeEmpty: e.target.checked })} />
          <span>
            Leave out empty values
            <span className="cc-http__checkhint">
              A parameter or field whose value is blank for this row is not sent at all, rather than
              sent as blank. Turn it off if the thing you are calling treats "missing" and "blank"
              differently.
            </span>
          </span>
        </label>

        <label className="cc-http__check">
          <input type="checkbox" checked={local.returnMetadata} disabled={busy} onChange={(e) => set({ returnMetadata: e.target.checked })} />
          <span>
            Keep the status code too
            <span className="cc-http__checkhint">
              The cell holds the reply along with the status and the final address, instead of the
              value alone. Useful while you are working out why something is not coming back.
            </span>
          </span>
        </label>

        <label className="cc-http__check">
          <input type="checkbox" checked={local.followRedirects} disabled={busy} onChange={(e) => set({ followRedirects: e.target.checked })} />
          <span>
            Follow redirects
            <span className="cc-http__checkhint">
              Every hop is checked, not just the first — but the allowance below covers the address
              you typed, not wherever it redirects to. A service you do not control can point the
              request somewhere you did not choose. Turn this off when posting to a webhook: a
              redirect there usually means the address is wrong, and you want to be told.
            </span>
          </span>
        </label>

        <label className="cc-http__check">
          <input
            type="checkbox"
            checked={local.allowPrivate}
            disabled={busy || !fixedHost}
            onChange={(e) => set({ allowPrivate: e.target.checked })}
          />
          <span>
            Allow addresses on this machine or network
            <span className="cc-http__checkhint">
              {fixedHost
                ? "Needed for something running on your own computer or office network, like localhost or an internal tool. Off by default because a web address you did not intend can otherwise reach things only you should."
                : "Unavailable while the address itself comes from a column. The part before the first slash decides which computer is contacted, and if a cell supplies it then the spreadsheet picks the destination — not you."}
            </span>
          </span>
        </label>
      </Section>

      {error && <div className="cc-errors" role="alert"><div className="cc-errors__row">{error}</div></div>}
    </div>
  );
}
