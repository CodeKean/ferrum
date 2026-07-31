// How fast a column is allowed to go.
//
// Two controls that look different and are the same decision — how many calls may be in flight, and
// how many may start per minute — so they live together and are applied at one point: just before a
// worker dispatches a cell.
//
// ── Why adaptive concurrency, rather than a number you pick ─────────────────────────────────────
//
// The fixed concurrency of 6 is a guess about someone else's rate limit. Set it too high and a run
// spends its life in retry backoff, hammering a provider that is already saying no — the retries are
// free (`retry_free`), so the run does not fail, it just crawls while looking healthy. Set it too low
// and a provider that would happily take twenty at once is fed six.
//
// Neither is knowable in advance, and both are knowable within about ten seconds of starting. So the
// engine finds out: halve on a rate limit, edge back up while things are going well. That is the
// standard shape (AIMD) and it is standard because it is right — back off FAST, because the cost of
// staying too fast is a provider blocking you, and recover SLOWLY, because the cost of being too
// eager is doing it all again.
//
// ── Why a per-minute cap as well ────────────────────────────────────────────────────────────────
//
// Concurrency does not bound a rate. Six workers against a provider answering in 50ms is 120 calls a
// second, which is inside every concurrency limit and outside most rate limits. When a provider
// states "60 requests per minute", that is the number to obey, and obeying it directly is better than
// discovering it by being refused.

/** The failure that means "you are going too fast", as classified by errorClass. */
const SLOW_DOWN: ReadonlySet<string> = new Set(["rate_limit"]);

/**
 * Consecutive good cells before the ceiling is allowed up by one.
 *
 * Deliberately not 1. Recovering after a single success turns one lucky call into a doubling and the
 * run oscillates between hammering and backing off — which is worse than either, because the provider
 * sees bursts and every burst risks a longer ban than a steady pace would.
 */
const RECOVER_AFTER = 12;

export interface PaceOptions {
  /** The ceiling to start at, and never exceed. */
  max: number;
  /** Calls this column may START per minute. 0 or absent means no limit. */
  perMinute?: number;
  /** Injected so tests are deterministic rather than slept through. */
  now?: () => number;
  /** Injected for the same reason. Resolves after ms, or when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });

export class Pacer {
  private readonly max: number;
  private readonly perMinute: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  /** The live ceiling. Starts at max and moves between 1 and max. */
  private limit: number;
  private inFlight = 0;
  private goodRun = 0;
  /** Start times of recent dispatches, for the per-minute window. Trimmed as it is read. */
  private starts: number[] = [];

  constructor(opts: PaceOptions) {
    this.max = Math.max(1, Math.floor(opts.max));
    this.perMinute = Math.max(0, Math.floor(opts.perMinute ?? 0));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.limit = this.max;
  }

  /** For the run strip and the tests: what the engine has decided the provider will take. */
  get concurrency(): number { return this.limit; }
  get active(): number { return this.inFlight; }

  /**
   * Wait until this worker may dispatch, then count it as in flight.
   *
   * Returns false when the wait was cut short by cancellation — the caller must not dispatch. A
   * pacer that resolved true on an aborted signal would let a stopped run make one more paid call
   * per worker, which is exactly the failure the abort plumbing exists to prevent.
   */
  async take(signal?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (signal?.aborted) return false;

      const waitFor = this.waitMs();
      if (waitFor === 0) { this.inFlight++; this.starts.push(this.now()); return true; }

      // Capped at a second per wait so cancellation is noticed promptly even when the rate window
      // says to wait a minute, and so a `limit` that rises while waiting is picked up.
      await this.sleep(Math.min(1000, waitFor), signal);
    }
  }

  /** How long before a dispatch would be allowed. 0 means now. */
  private waitMs(): number {
    if (this.inFlight >= this.limit) return 250;
    if (this.perMinute === 0) return 0;

    const cutoff = this.now() - 60_000;
    // Trimmed here rather than on a timer: the array only grows while cells are being dispatched,
    // and this is the only reader.
    if (this.starts.length > 0 && this.starts[0]! <= cutoff) {
      this.starts = this.starts.filter((t) => t > cutoff);
    }
    if (this.starts.length < this.perMinute) return 0;
    // The oldest start in the window falls out at this point, and one slot opens with it.
    return Math.max(1, this.starts[0]! + 60_000 - this.now());
  }

  /** A cell finished. `errorType` is whatever the outcome carried, or null on success. */
  done(errorType: string | null | undefined): void {
    this.inFlight = Math.max(0, this.inFlight - 1);

    if (errorType && SLOW_DOWN.has(errorType)) {
      // HALVED, not decremented. A provider refusing at twelve will usually also refuse at eleven,
      // so stepping down one at a time spends a dozen more refusals arriving where halving arrives
      // immediately. The floor is 1: a column may end up serial, which is slow and is still running.
      this.limit = Math.max(1, Math.floor(this.limit / 2));
      this.goodRun = 0;
      return;
    }

    // Only a clean cell counts toward recovery. An `auth` or `schema` failure says nothing about
    // pace, so it neither slows things down nor earns the run back up — treating it as a success
    // would let a column failing on every row accelerate.
    if (errorType) return;

    this.goodRun++;
    if (this.goodRun >= RECOVER_AFTER && this.limit < this.max) {
      this.limit++;
      this.goodRun = 0;
    }
  }
}
