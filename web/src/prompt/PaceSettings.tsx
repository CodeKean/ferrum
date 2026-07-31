// How fast a column is allowed to run, and how long it holds a row.
//
// Two numbers that live next to each other because they answer the same question — "how quickly does
// this column go through rows?" — and are both about the CLOCK rather than the answer. Neither
// changes a single cell's value, which is why they sit on the Mode tab beside the cost rather than
// on the screen where the prompt or the request is written.
//
// Both save themselves. The drawer's Save belongs to the generated rule, and a second Save in the
// same footer meaning something else is how a user ends up believing they saved one and saved the
// other.

import { useEffect, useState } from "react";
import { Section } from "../ui/Section.tsx";
import "./PaceSettings.css";

/** The engine's ceiling, restated here so the field cannot ask for something the server will clamp. */
const WAIT_MAX_SECONDS = 3600;
const RATE_MAX = 100_000;

/**
 * How many rows a run does at once by default — `DEFAULT_CONCURRENCY` in src/runs.ts.
 *
 * Restated rather than imported because this is only used to say a wall-clock estimate out loud, and
 * the run dialog is free to be set to something else. If the engine's default changes, this line
 * makes the estimate optimistic, not the run wrong.
 */
export const DEFAULT_AT_A_TIME = 6;

/**
 * A duration in words, so nobody has to divide by sixty to find out what they just typed.
 *
 * 900 is not obviously fifteen minutes, and the difference between 300 and 3000 on a sheet with
 * thousands of rows is the difference between a coffee and an afternoon.
 */
export function saySeconds(n: number): string {
  if (n <= 0) return "no wait — rows pass straight through";
  if (n < 60) return `${n} second${n === 1 ? "" : "s"}`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  const mins = `${m} minute${m === 1 ? "" : "s"}`;
  if (m < 60) return s ? `${mins} ${s}s` : mins;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  const hours = `${h} hour${h === 1 ? "" : "s"}`;
  return rm ? `${hours} ${rm} minutes` : hours;
}

/**
 * What the wait costs in wall-clock across the whole sheet.
 *
 * Rows wait in PARALLEL — six at a time by default, or however many the run is set to — so the
 * honest number is rows ÷ at-a-time × the wait, not rows × the wait. Stating it is the whole point
 * of the control: "10 seconds" reads as nothing until you see it is four hours on 8,000 rows.
 */
export function waitSpan(seconds: number, rows: number, atATime: number): string | null {
  if (seconds <= 0 || rows <= 0) return null;
  const total = Math.ceil(rows / Math.max(1, atATime)) * seconds;
  return `About ${saySeconds(total)} of waiting for ${rows.toLocaleString()} rows, ${atATime} at a time.`;
}

interface Props {
  /** 0 means no limit — the honest way to say it, and the default. */
  rateLimitPerMin: number;
  waitSeconds: number;
  /** Only the lanes that call something outside can be rate limited. */
  showRate: boolean;
  showWait: boolean;
  rowCount: number;
  /** How many rows a run does at once, for the wall-clock line. */
  atATime: number;
  busy: boolean;
  onSave: (patch: { rateLimitPerMin?: number; waitSeconds?: number }) => Promise<void>;
}

export function PaceSettings({
  rateLimitPerMin, waitSeconds, showRate, showWait, rowCount, atATime, busy, onSave,
}: Props) {
  // Held as text, so clearing the field to type a new number does not snap to 0 mid-keystroke.
  const [rate, setRate] = useState(String(rateLimitPerMin || ""));
  const [wait, setWait] = useState(String(waitSeconds || ""));

  useEffect(() => { setRate(String(rateLimitPerMin || "")); }, [rateLimitPerMin]);
  useEffect(() => { setWait(String(waitSeconds || "")); }, [waitSeconds]);

  const clampRate = (s: string) => Math.max(0, Math.min(RATE_MAX, Math.floor(Number(s) || 0)));
  const clampWait = (s: string) => Math.max(0, Math.min(WAIT_MAX_SECONDS, Math.floor(Number(s) || 0)));

  if (!showRate && !showWait) return null;

  return (
    <>
      {showWait && (
        <div className="cc-pace">
          <label className="cc-pace__row" htmlFor="cc-pace-wait">
            <span className="cc-pace__label">Hold each row for</span>
            <span className="cc-pace__field">
              <input
                id="cc-pace-wait"
                className="cc-pace__input"
                type="number"
                min={0}
                max={WAIT_MAX_SECONDS}
                value={wait}
                disabled={busy}
                onChange={(e) => setWait(e.target.value)}
                onBlur={() => { const n = clampWait(wait); setWait(String(n || "")); if (n !== waitSeconds) void onSave({ waitSeconds: n }); }}
              />
              <span className="cc-pace__unit">seconds</span>
            </span>
          </label>
          <p className="cc-pace__say">{saySeconds(clampWait(wait))}</p>
          {waitSpan(clampWait(wait), rowCount, atATime) && (
            <p className="cc-pace__hint">{waitSpan(clampWait(wait), rowCount, atATime)}</p>
          )}
          <p className="cc-pace__hint">
            An hour is the most one column will hold a row. Past that, a scheduled run is the honest
            way to do it — it survives closing the app, and a held-open wait does not.
          </p>
        </div>
      )}

      {showRate && (
        <Section
          label="Speed limit"
          summary={rateLimitPerMin > 0 ? `${rateLimitPerMin}/min` : "no limit"}
        >
          <p className="cc-pace__hint">
            Some APIs answer “too many requests” if you go faster than their plan allows. Put their
            number here and this column stays under it. The run already slows itself down when it is
            told off — this stops it being told off in the first place.
          </p>
          <label className="cc-pace__row" htmlFor="cc-pace-rate">
            <span className="cc-pace__label">At most</span>
            <span className="cc-pace__field">
              <input
                id="cc-pace-rate"
                className="cc-pace__input"
                type="number"
                min={0}
                max={RATE_MAX}
                placeholder="no limit"
                value={rate}
                disabled={busy}
                onChange={(e) => setRate(e.target.value)}
                onBlur={() => { const n = clampRate(rate); setRate(String(n || "")); if (n !== rateLimitPerMin) void onSave({ rateLimitPerMin: n }); }}
              />
              <span className="cc-pace__unit">rows a minute</span>
            </span>
          </label>
          <p className="cc-pace__say">
            {clampRate(rate) > 0
              ? `${(clampRate(rate) * 60).toLocaleString()} an hour at most.`
              : "No limit — as fast as the run goes."}
          </p>
        </Section>
      )}
    </>
  );
}
