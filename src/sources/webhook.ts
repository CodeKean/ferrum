// Rows arriving from somewhere else.
//
// Every other way data enters a sheet is something the user does: a CSV import, a typed cell, a run.
// This is the one where data arrives on its own, from a form, a Zapier step, an n8n flow, a CRM
// trigger — anything that can post JSON at a URL.
//
// ── Why this is the only unauthenticated surface in the app, and what makes that safe ────────────
//
// The whole engine binds to localhost precisely because it holds provider keys and a tool-capable
// agent runner. A webhook is useless if the sender has to already be inside that boundary, so this
// endpoint is reachable without a session — and everything below exists because of it:
//
//   The TOKEN is the credential, it is 32 bytes of randomness, and it is compared in constant time.
//   A token that leaks is revoked by rotating it, which is one write.
//
//   A DISABLED source answers exactly as a wrong token does. Otherwise the two responses tell an
//   enumerator which tokens exist.
//
//   The body is CAPPED and the mapping is EXPLICIT. A payload cannot create columns, cannot decide
//   which columns it lands in, and cannot grow a sheet by a field it invented. What is not mapped is
//   not stored.
//
//   The WORK one delivery can ask for is bounded: the body has a size limit, the batch has a record
//   limit, and the table's own duplicate sweep — which is whole-table by construction — runs at most
//   once every few seconds per table. Otherwise a stranger with a loop decides how much of the
//   engine's single thread this endpoint consumes.
//
//   Deliveries are RECORDED, including the failures, because a webhook that silently drops a payload
//   is indistinguishable from one nobody ever called.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { cellId, db, getKv, renumberColumns, setKv, tx } from "../db.ts";
import { getPath, toText } from "../jsonPath.ts";
import { addColumn, invalidateRowCount, listColumns, nextRowPosition, setColumnFrozen } from "../store.ts";
import { bumpDataVersion } from "../store.ts";
import { markSheetDirty } from "../columnStats.ts";
import { markCellsDirty } from "../bus.ts";
import { autoDedupe, normalizeKey } from "../dedupe.ts";

/** How much JSON one delivery may carry. Generous for a record, far short of a data dump. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * How many records one delivery may carry.
 *
 * The body limit alone does not bound the WORK: 256KB of tiny objects is thousands of rows, each one
 * a key lookup and a cell write, all of it synchronous on the only thread this app has. A batch over
 * this is a configuration mistake far more often than it is a real payload, so it is refused with a
 * recorded reason rather than trimmed — a silently truncated batch is data loss the sender is never
 * told about.
 */
export const MAX_RECORDS = 1000;

/** Deliveries kept per source. Enough to debug a live integration, bounded so it cannot grow forever. */
const KEEP_DELIVERIES = 50;

/**
 * How often the table's own duplicate rule may run behind a delivery, per table.
 *
 * The sweep compares every row against every other — that is what deduplication IS — so its cost is
 * the size of the whole table, not the size of the delivery: measured at 40ms over 20,005 rows and
 * 85ms over 40,010, which is about a second per POST at the million-row target. Running it for every
 * delivery put that on the single thread of an endpoint with no authentication and no rate limit, so
 * anyone who could post could freeze the engine by posting in a loop.
 *
 * Rows are still deduplicated. Just once per window rather than once per delivery, and a burst that
 * arrives inside the window schedules the sweep for the end of it, so nothing is left unswept.
 */
const DEDUPE_MIN_INTERVAL_MS = 10_000;

export interface WebhookSource {
  id: number;
  sheetId: string;
  name: string;
  token: string;
  enabled: boolean;
  /**
   * The column the whole record lands in, created on the first delivery.
   *
   * This is the difference between a webhook you can set up and one you cannot. Describing a payload
   * BEFORE having seen one means guessing at field names, and every guess that is wrong shows up as
   * an empty column rather than an error. So the first delivery is not asked to fit a shape: it
   * lands intact in one pinned column, and every real column is derived from the JSON sitting there
   * — by clicking a field in the cell panel, which already knows how to turn one into a column.
   *
   * Mapping still works and still wins when it is set. This is the starting point, not a replacement.
   */
  payloadColumnId: number | null;
  /** targetColumnId -> dotted path into the posted body. */
  mapping: Record<string, string>;
  /**
   * Path whose value identifies the record.
   *
   * With one set, a second delivery for the same value UPDATES the row it made the first time. A
   * webhook is retried by almost every sender that exists — on a timeout, on a 500, on a deploy —
   * so without this a flaky network quietly doubles the sheet.
   */
  keyPath: string | null;
  /** Path to a list, when one delivery carries many records. Empty means the body is one record. */
  itemsPath: string | null;
  createdAt: string;
  lastAt: string | null;
  received: number;
  rejected: number;
}

function toSource(r: any): WebhookSource {
  return {
    id: Number(r.id),
    sheetId: r.sheet_id,
    name: r.name,
    token: r.token,
    enabled: !!r.enabled,
    payloadColumnId: r.payload_column_id == null ? null : Number(r.payload_column_id),
    mapping: r.mapping_json ? JSON.parse(r.mapping_json) : {},
    keyPath: r.key_path ?? null,
    itemsPath: r.items_path ?? null,
    createdAt: r.created_at,
    lastAt: r.last_at ?? null,
    received: Number(r.received ?? 0),
    rejected: Number(r.rejected ?? 0),
  };
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function listSources(sheetId: string): WebhookSource[] {
  return (db.prepare("SELECT * FROM webhook_sources WHERE sheet_id = ? ORDER BY id").all(sheetId) as any[]).map(toSource);
}

export function getSource(id: number): WebhookSource | null {
  const r = db.prepare("SELECT * FROM webhook_sources WHERE id = ?").get(id) as any;
  return r ? toSource(r) : null;
}

/**
 * Find a source by token, in constant time.
 *
 * A plain `WHERE token = ?` would be simpler and would also leak: SQLite's string comparison exits
 * at the first differing byte, and the timing difference is measurable across enough requests. The
 * candidate set here is tiny — a handful of sources per install — so comparing them all costs
 * nothing and removes the question entirely.
 */
export function findByToken(token: string): WebhookSource | null {
  if (!token) return null;
  const want = Buffer.from(token);
  let found: WebhookSource | null = null;
  for (const r of db.prepare("SELECT * FROM webhook_sources").all() as any[]) {
    const have = Buffer.from(String(r.token));
    // Lengths must match before timingSafeEqual will look at the bytes, and a length mismatch is
    // not secret — the token length is fixed and public.
    if (have.length === want.length && timingSafeEqual(have, want)) found = toSource(r);
  }
  return found;
}

export function createSource(sheetId: string, name: string): WebhookSource {
  const info = db
    .prepare(
      `INSERT INTO webhook_sources (sheet_id, name, token, enabled, mapping_json, created_at)
       VALUES (?, ?, ?, 1, '{}', datetime('now'))`,
    )
    .run(sheetId, name.trim() || "Incoming data", newToken());
  return getSource(Number(info.lastInsertRowid))!;
}

export function updateSource(
  id: number,
  patch: { name?: string; enabled?: boolean; mapping?: Record<string, string>; keyPath?: string | null; itemsPath?: string | null },
): WebhookSource | null {
  const before = getSource(id);
  if (!before) return null;
  db.prepare(
    `UPDATE webhook_sources
        SET name = ?, enabled = ?, mapping_json = ?, key_path = ?, items_path = ?
      WHERE id = ?`,
  ).run(
    patch.name ?? before.name,
    (patch.enabled ?? before.enabled) ? 1 : 0,
    JSON.stringify(patch.mapping ?? before.mapping),
    patch.keyPath === undefined ? before.keyPath : (patch.keyPath || null),
    patch.itemsPath === undefined ? before.itemsPath : (patch.itemsPath || null),
    id,
  );
  return getSource(id);
}

export function rotateToken(id: number): WebhookSource | null {
  db.prepare("UPDATE webhook_sources SET token = ? WHERE id = ?").run(newToken(), id);
  return getSource(id);
}

export function deleteSource(id: number): void {
  db.prepare("DELETE FROM webhook_deliveries WHERE source_id = ?").run(id);
  // The "payload column was thrown away" fact lives in `kv` keyed by source id, so it has no foreign
  // key to travel on and it outlived the source it described — one orphaned row left behind every
  // time a source was set up, used and removed, forever. That it never yet became a WRONG answer is
  // an accident of `webhook_sources.id` being AUTOINCREMENT: reissue an id once and a brand-new
  // source inherits "your payload column was deleted", refuses every delivery it ever receives, and
  // nothing on the sources screen can clear it. Dropped here beside the deliveries, so no invariant
  // on the far side of the schema has to hold this up.
  db.prepare("DELETE FROM kv WHERE k = ?").run(payloadDroppedKey(id));
  db.prepare("DELETE FROM webhook_sources WHERE id = ?").run(id);
}

/**
 * Where "the user threw the payload column away" is remembered.
 *
 * A fact about a source that has no column of its own on `webhook_sources`, so it lives in `kv`
 * beside the other small engine-side facts (`auth.mode`, `provider.*.label`). Recording it is the
 * whole point: the alternative is to re-derive it every delivery from a lookup that returns nothing,
 * and "no column" reads equally well as "make one" — which is exactly the reading that produced a
 * new column on every delivery after a delete.
 */
const payloadDroppedKey = (sourceId: number): string => `webhook.${sourceId}.payload_column_dropped`;

/**
 * Record that a payload column was thrown away, at the moment it is thrown away.
 *
 * Nothing calls this from a user path yet — the column-delete route is where it belongs. The
 * delivery path records the same fact the first time it notices the column is gone, so wiring this
 * in only makes the record earlier, never different.
 */
export function notePayloadColumnDeleted(columnId: number | string): void {
  for (const r of db
    .prepare("SELECT id FROM webhook_sources WHERE payload_column_id = ?")
    .all(Number(columnId)) as any[]) {
    setKv(payloadDroppedKey(Number(r.id)), "1");
  }
}

/**
 * The column a delivery lands in whole, made on demand. Null when this source is not entitled to
 * one, which today means exactly one thing: the user deleted the one it had.
 *
 * Placed FIRST and pinned, for the same reason Clay does: it is the row's identity until columns are
 * derived from it. Everything else on that row was worked out from this, so it reads left-to-right
 * as cause then consequence, and it stays on screen while the derived columns scroll.
 *
 * Made on the first delivery rather than when the source is created, because a source that has never
 * been called has nothing to show and an empty JSON column is just clutter in the way.
 */
export function ensurePayloadColumn(source: WebhookSource): number | null {
  const dropped = payloadDroppedKey(source.id);
  const existing = source.payloadColumnId;

  if (existing != null) {
    const live = db.prepare("SELECT id FROM columns WHERE id = ? AND deleted_at IS NULL").get(existing);
    if (live) {
      // Column deletion is SOFT and undo puts the column back, so a source whose column returned has
      // to return with it — otherwise one undo leaves the integration refusing deliveries forever
      // over a column that is sitting right there.
      if (getKv(dropped) === "1") setKv(dropped, "0");
      return existing;
    }
    // Deleted by hand. That is a legitimate way to say "I have derived what I needed" — and it used
    // to be read as "so make a fresh one", inferred from a lookup that came back empty. Every delete
    // therefore produced ANOTHER column at position 0 and shifted the whole sheet right again, with
    // nothing bounding it: four deletes, four payload columns, the user's own first column sitting
    // at position 4. So the intent is RECORDED here instead of re-inferred next time, the link is
    // kept so an undo can restore it, and the delivery is refused with a reason rather than answered
    // with a column nobody asked for.
    setKv(dropped, "1");
    return null;
  }

  if (getKv(dropped) === "1") return null;

  return tx(() => {
    // Everything already in the sheet shifts right by one. Positions need not be contiguous, so this
    // is the whole cost of putting a column first — and it now happens at most ONCE per source,
    // which is what makes that cost affordable to keep. In the same transaction as the column it is
    // making room for, so a failed insert cannot leave a sheet shifted around a gap.
    // NOT `position = position + 1`. SQLite applies that row by row, so the column at 0 becomes 1
    // while the column already at 1 is still sitting there, and `ux_columns_sheet_pos` rejects it.
    // renumberColumns parks the whole set on negative positions first so no intermediate state
    // collides. Soft-deleted columns shift too: they are outside the index, but a later undo brings
    // one back, and it has to land in the order the user remembers rather than on top of something.
    const shifted = db
      .prepare("SELECT id, position FROM columns WHERE sheet_id = ? ORDER BY position DESC")
      .all(source.sheetId) as any[];
    renumberColumns(shifted.map((c) => [Number(c.id), Number(c.position) + 1] as const));
    const col = addColumn(source.sheetId, {
      name: `${source.name} payload`,
      kind: "static",
      valueType: "json",
      position: 0,
    });
    setColumnFrozen(col.id, true);
    db.prepare("UPDATE webhook_sources SET payload_column_id = ? WHERE id = ?").run(Number(col.id), source.id);
    source.payloadColumnId = Number(col.id);
    return Number(col.id);
  });
}

// ─────────────────────────────────────────────────────────────── deliveries

export interface Delivery {
  id: number;
  at: string;
  ok: boolean;
  rowsWritten: number;
  note: string | null;
  /** The body as received, truncated. What makes a mis-mapped field debuggable. */
  body: string;
}

export function listDeliveries(sourceId: number, limit = 20): Delivery[] {
  return (
    db
      .prepare("SELECT * FROM webhook_deliveries WHERE source_id = ? ORDER BY id DESC LIMIT ?")
      .all(sourceId, limit) as any[]
  ).map((r) => ({
    id: Number(r.id),
    at: r.at,
    ok: !!r.ok,
    rowsWritten: Number(r.rows_written ?? 0),
    note: r.note ?? null,
    body: r.body ?? "",
  }));
}

function recordDelivery(sourceId: number, ok: boolean, rowsWritten: number, note: string | null, body: string): void {
  db.prepare(
    `INSERT INTO webhook_deliveries (source_id, at, ok, rows_written, note, body)
     VALUES (?, datetime('now'), ?, ?, ?, ?)`,
  ).run(sourceId, ok ? 1 : 0, rowsWritten, note, body.slice(0, 4000));
  db.prepare(
    `UPDATE webhook_sources
        SET last_at = datetime('now'),
            received = received + ?,
            rejected = rejected + ?
      WHERE id = ?`,
  ).run(ok ? 1 : 0, ok ? 0 : 1, sourceId);
  // Trimmed on write rather than by a sweeper: a busy source is exactly the one that would otherwise
  // accumulate, and it is also the one writing often enough to trim itself.
  db.prepare(
    `DELETE FROM webhook_deliveries
      WHERE source_id = ?
        AND id NOT IN (SELECT id FROM webhook_deliveries WHERE source_id = ? ORDER BY id DESC LIMIT ?)`,
  ).run(sourceId, sourceId, KEEP_DELIVERIES);
}

/** Said in one place, because the delivery path and the route both have to say it. */
const DISABLED_NOTE = "This source is switched off.";

/**
 * Record a delivery to a source that is switched off, without answering the sender any differently.
 *
 * The route answers a disabled token exactly as it answers an unknown one — a distinct "this token
 * exists but is off" is what tells an enumerator which tokens are real — and it does that BEFORE
 * calling `deliver`, so the branch inside `deliver` never runs on the live path and nothing was ever
 * written down. "We switched it off and they kept sending" is the whole reason the delivery list
 * exists, and the sources screen promises it in as many words. So the route records through this and
 * then 404s as before: the record is for the owner, the response is for the stranger.
 */
export function recordDisabledDelivery(source: WebhookSource, rawText: string): void {
  recordDelivery(source.id, false, 0, DISABLED_NOTE, rawText);
}

// ─────────────────────────────────────────────────────────────── the write

export interface DeliveryResult {
  ok: boolean;
  inserted: number;
  updated: number;
  /**
   * Rows the TABLE's own duplicate rule removed afterwards, from the whole table — not rows this
   * delivery brought. Its own field, the way `importCsv` reports it, because it was being folded
   * into the delivery's note as "5 duplicate rows removed" and read as a consequence of the POST:
   * one brand-new unique record, and the note said five rows had gone, four of which predated the
   * integration entirely.
   */
  dedupedAfter: number;
  note?: string;
}

/**
 * A delivery that stored nothing, recorded and returned in one shape.
 *
 * Every refusal here has to do both — a refusal the owner cannot see is the failure mode this whole
 * file is built against — so there is one way to write one.
 */
function refuse(source: WebhookSource, note: string, rawText: string): DeliveryResult {
  recordDelivery(source.id, false, 0, note, rawText);
  return { ok: false, inserted: 0, updated: 0, dedupedAfter: 0, note };
}

/**
 * Name the mapped columns that are no longer here, in words the person who set the source up can act
 * on.
 *
 * Looks columns up WITHOUT the deleted filter on purpose: the whole point is to say "Company", not
 * "column 42", and a soft-deleted column still knows its own name.
 */
function missingColumnsNote(missing: string[]): string {
  const ids = missing.map(Number).filter(Number.isInteger);
  const names = new Map<number, string>();
  if (ids.length > 0) {
    const holes = ids.map(() => "?").join(",");
    for (const r of db.prepare(`SELECT id, name FROM columns WHERE id IN (${holes})`).all(...ids) as any[]) {
      names.set(Number(r.id), String(r.name));
    }
  }
  const listed = missing
    .map((id) => {
      const name = names.get(Number(id));
      return name ? `"${name}"` : `column ${id}`;
    })
    .join(", ");
  const one = missing.length === 1;
  return (
    `Nothing was stored. The mapping still points at ${listed}, ` +
    `${one ? "which is" : "which are"} no longer in this table. ` +
    `Put ${one ? "it" : "them"} back, or take ${one ? "it" : "them"} out of the mapping, ` +
    `and send this delivery again.`
  );
}

/** Values a phone column can be canonicalised without losing anything: digits and their punctuation. */
const PHONE_ONLY = /^[+()\-.\s\d]+$/;

/**
 * The form a mapped value is STORED in.
 *
 * The dedupe key was normalized — trimmed, lower-cased, type-aware — and the value written beside it
 * was not, so the same logical record showed a different literal on every retry: `Ada@Example.com`
 * from one delivery, `ada@example.com` from the next, the row's identity saying they are the same
 * record while the cell said they were not.
 *
 * Deliberately NOT the whole of `normalizeKey`. A KEY may throw information away, because comparing
 * is all it is ever used for; a CELL is the data. `normalizeKey` reduces a URL to host + path, which
 * would delete the query string of every link a sender delivers, and a phone number to its digits,
 * which would swallow an extension into the number. So this keeps everything that could be data and
 * drops only what never is: surrounding whitespace, and case where case is not meaning.
 */
function normalizeValue(text: string | null, valueType: string): string | null {
  if (text == null) return null;
  const v = text.trim();
  if (!v) return v;

  if (valueType === "email") return normalizeKey(v, "email") ?? v;

  if (valueType === "url") {
    // Only the scheme and the host are case-insensitive. Path, query and fragment are not, and a
    // server that treats them as such is not something this is entitled to assume.
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]+)/.exec(v);
    return m ? m[1]!.toLowerCase() + m[2]!.toLowerCase() + v.slice(m[0]!.length) : v;
  }

  // Only when the value is a phone number and nothing else. "555 0100 ext 12" keeps its extension
  // rather than having it merged into the digits.
  if (valueType === "phone" && PHONE_ONLY.test(v)) return normalizeKey(v, "phone") ?? v;

  return v;
}

const lastDedupeAt = new Map<string, number>();
const dedupePending = new Set<string>();

/**
 * Run the table's own duplicate rule, at most once per window per table.
 *
 * Returns how many rows it removed when it ran now, and 0 when the window is still open — in which
 * case the sweep is SCHEDULED for the end of it, so a burst of deliveries is still deduplicated,
 * once, instead of once per delivery. 0 here means "not measured", never "there were none", which is
 * why the caller reports it as its own field and says nothing when it is zero.
 */
function dedupeSoon(sheetId: string): number {
  const now = Date.now();
  const last = lastDedupeAt.get(sheetId) ?? 0;

  if (now - last >= DEDUPE_MIN_INTERVAL_MS) {
    lastDedupeAt.set(sheetId, now);
    // Guarded for the same reason the deferred sweep below is, with more riding on it. By the time
    // this runs the delivery's rows are COMMITTED and `recordDelivery` has not happened yet, so a
    // throw here took the delivery down after writing it: rows sitting in the sheet, no entry in the
    // delivery list, neither counter moved, and the sender handed a 500 — which on /hook is an
    // unhandled stack-trace page. "A webhook that silently drops a payload is indistinguishable from
    // one nobody ever called" is the promise at the top of this file, and an unguarded whole-table
    // sweep broke it on exactly the delivery an operator would most need to see.
    //
    // The window is consumed before the attempt, deliberately: a sweep that is failing must not be
    // retried on every single delivery.
    try {
      return autoDedupe(sheetId)?.duplicates ?? 0;
    } catch (e) {
      console.warn("[webhook] dedupe after delivery failed:", e instanceof Error ? e.message : e);
      return 0;
    }
  }

  if (!dedupePending.has(sheetId)) {
    dedupePending.add(sheetId);
    // Clamped to one window. The delay is worked out from a WALL clock, so a backward step — an NTP
    // correction, a VM resume, someone setting the system time — makes `now - last` negative and
    // pushes the sweep out by the whole size of the jump, while `dedupePending` blocks anything from
    // rescheduling it in the meantime. "Swept at the end of the window" silently became "swept in an
    // hour", on the one path whose entire job is to bound how long a burst stays unswept. The clamp
    // is a no-op whenever the clock behaves, and the timer resets `lastDedupeAt` from the clock it
    // actually fired on, so one window is the most that can ever be lost.
    const delay = Math.min(DEDUPE_MIN_INTERVAL_MS, Math.max(0, DEDUPE_MIN_INTERVAL_MS - (now - last)));
    setTimeout(() => {
      dedupePending.delete(sheetId);
      lastDedupeAt.set(sheetId, Date.now());
      // A throw in a timer takes the process down, and a duplicate sweep is not worth an engine.
      try { autoDedupe(sheetId); } catch (e) {
        console.warn("[webhook] deferred dedupe failed:", e instanceof Error ? e.message : e);
      }
    }, delay).unref?.();
  }
  return 0;
}

/**
 * Turn one posted body into rows.
 *
 * Everything about what lands is decided by the SOURCE, never by the payload. A field the mapping
 * does not mention is not stored, and no column is ever created — which is what stops a chatty
 * sender from turning a sheet into a copy of its own schema.
 */
export function deliver(source: WebhookSource, body: unknown, rawText: string): DeliveryResult {
  if (!source.enabled) return refuse(source, DISABLED_NOTE, rawText);

  let cols = listColumns(source.sheetId);
  const liveIds = new Set(cols.map((c) => Number(c.id)));

  // A mapped column that is GONE is not a field to quietly skip.
  //
  // The mapping is NOT filtered against the live columns. Doing that makes deleting one remove its
  // field from every delivery afterwards without a word: the incoming value dropped, the row written
  // with exactly the hole the comment below says this prevents, and when the deleted column was one
  // of the table's dedupe keys the sheet stopped matching duplicates at all — three retries of the
  // same record landed as three rows on a table with automatic dedupe explicitly switched on. All of
  // it silent, on the one path where the sender is a stranger who will never look at this table. So
  // the delivery fails instead and names the column, and the sender's own retry is what recovers the
  // data once the mapping is put right.
  const missing = Object.keys(source.mapping).filter((colId) => !liveIds.has(Number(colId)));
  if (missing.length > 0) return refuse(source, missingColumnsNote(missing), rawText);

  const entries = Object.entries(source.mapping);

  // One delivery can carry a list. Anything else is one record, including a bare array when no items
  // path is set — guessing there would make the shape depend on the payload rather than the config.
  //
  // Absent, null and EMPTY are three different answers and used to collapse into one failure. A
  // poller with nothing to send posts an empty list: that is a delivery that succeeded and had
  // nothing to do, and answering "failed" makes it retry a payload that was never wrong and shows
  // its owner a red count for a healthy integration.
  let records: unknown[];
  if (source.itemsPath) {
    const at = getPath(body, source.itemsPath);
    if (at === undefined) return refuse(source, `Nothing found at "${source.itemsPath}" in this delivery.`, rawText);
    if (at === null) return refuse(source, `"${source.itemsPath}" was null in this delivery, so there was nothing to read.`, rawText);
    if (Array.isArray(at) && at.length === 0) {
      const note = "Nothing to add — the list was empty.";
      recordDelivery(source.id, true, 0, note, rawText);
      return { ok: true, inserted: 0, updated: 0, dedupedAfter: 0, note };
    }
    records = Array.isArray(at) ? at : [at];
  } else {
    records = [body];
  }

  if (records.length > MAX_RECORDS) {
    return refuse(
      source,
      `This delivery carried ${records.length} records and the most one delivery may carry is ${MAX_RECORDS}. ` +
        `Nothing was stored — send them in smaller batches.`,
      rawText,
    );
  }

  // Nothing mapped is the NORMAL state on the first delivery, not a failure. The record lands whole
  // in one pinned column and the user derives columns from what actually arrived — which they can
  // now see, instead of having had to predict it.
  let payloadColumnId: number | null = null;
  if (entries.length === 0) {
    // A body carrying no record at all — `null`, which is what an unparseable one arrives as — has
    // nothing to land, and making a column for it would mutate the sheet on a delivery that stored
    // nothing.
    if (!records.some((r) => r != null)) {
      return refuse(source, "Nothing was stored — this delivery carried no record to land anywhere.", rawText);
    }
    payloadColumnId = ensurePayloadColumn(source);
    if (payloadColumnId == null) {
      return refuse(
        source,
        "Nothing was stored — the column deliveries landed in whole was deleted, and this source maps no fields. " +
          "Map the fields you want kept, or set the source up again.",
        rawText,
      );
    }
    cols = listColumns(source.sheetId);
  }

  const valueTypes = new Map(cols.map((c) => [Number(c.id), String(c.valueType)]));

  let inserted = 0;
  let updated = 0;
  /** Records that matched nothing at all. They are not rows. */
  let skipped = 0;
  /** Rows a key matched where the statement wrote no cell, because every mapped cell is pinned. */
  let untouched = 0;
  const dirty: string[] = [];

  const allColumnIds = cols.map((c) => Number(c.id));
  let position = nextRowPosition(source.sheetId);

  tx(() => {
    const findRow = db.prepare("SELECT id FROM rows WHERE sheet_id = ? AND dedupe_key = ?");
    const insRow = db.prepare("INSERT INTO rows (sheet_id, position, dedupe_key) VALUES (?, ?, ?)");
    const insCell = db.prepare(
      "INSERT INTO cells (row_id, column_id, status, value_text, value_json) VALUES (?, ?, ?, ?, ?)",
    );
    const upd = db.prepare(
      `UPDATE cells SET value_text = ?, value_json = NULL, status = ?, rev = rev + 1,
                        error_type = NULL, error_msg = NULL, updated_at = datetime('now')
        WHERE row_id = ? AND column_id = ? AND pinned = 0`,
    );

    for (const rec of records) {
      const values = new Map<number, string | null>();
      for (const [colId, path] of entries) {
        const raw = path ? getPath(rec, path) : rec;
        // ABSENT IS NOT A VALUE. `getPath` returns undefined for a field the payload does not carry
        // and null for one it carries as null, and the difference is the whole of this: a retry that
        // omitted a field would write null over the cell the first delivery filled in — and mark it
        // done, a state the insert path never produces, so the grid could not tell "erased
        // by a retry" from "never arrived". A row holding email + name + company became email + null
        // + null across two posts of the same record. What the payload does not mention is left
        // exactly as it is.
        if (raw === undefined) continue;
        const id = Number(colId);
        values.set(id, normalizeValue(toText(raw), valueTypes.get(id) ?? "text"));
      }
      if (payloadColumnId != null && rec != null) {
        // Pretty-printed, because this cell is read by a person deciding what to pull out of it, and
        // the JSON tree in the cell panel parses it back either way.
        values.set(payloadColumnId, JSON.stringify(rec, null, 2));
      }

      // A record that resolved nothing is not a blank row.
      //
      // Otherwise it becomes one: every mapped path missing means every value null, the row goes in
      // empty, and because its dedupe key is null too it escapes the key-path idempotency that
      // exists to make retries safe — so each retry of a payload shaped wrong added another blank
      // row, without limit. Counted instead, and reported, because "we stored nothing" is the answer
      // the sender needs.
      if (values.size === 0) { skipped++; continue; }

      const keyRaw = source.keyPath ? getPath(rec, source.keyPath) : null;
      const key = keyRaw == null ? null : String(toText(keyRaw) ?? "").trim().toLowerCase() || null;

      const hit = key ? (findRow.get(source.sheetId, key) as any) : null;
      if (hit) {
        const rowId = Number(hit.id);
        let wrote = 0;
        for (const [colId, v] of values) {
          // `changes` is the only truth about whether anything was written: the statement refuses a
          // PINNED cell, and counting the attempt reported "1 updated" for a row where every mapped
          // cell was pinned and not one byte moved.
          //
          // The status mirrors the insert path — a value present is done, a value that arrived as
          // null is empty. Writing 'done' over a null was a state nothing else in the app produces.
          const changes = Number(upd.run(v, v != null ? "done" : "empty", rowId, colId).changes ?? 0);
          if (changes === 0) continue;
          wrote += changes;
          dirty.push(cellId(rowId, colId));
        }
        if (wrote > 0) updated++;
        else untouched++;
        continue;
      }

      const rowId = Number(insRow.run(source.sheetId, position++, key).lastInsertRowid);
      // EVERY column gets a cell, not just the mapped ones. A row with holes breaks the grid's
      // window read and leaves nothing for a later run to target — an unmapped column on a
      // webhook-created row is exactly the one someone then wants to enrich.
      for (const colId of allColumnIds) {
        const v = values.get(colId) ?? null;
        // `value_json` is deliberately NOT written — the same rule `insertRows` follows, and here it
        // had also put the two halves of this file at odds with each other: the insert stored a
        // quoted duplicate of `value_text` while the UPDATE five lines up sets `value_json = NULL`,
        // so one record read back differently depending on whether it had ever been retried. Now
        // that a reader takes `value_json ?? value_text`, that is not merely wasted bytes (measured
        // at 124% of the text column on a webhook-fed table) but two different parse paths for one
        // value. Everything reaching here is already a string — a mapped value through `toText`, the
        // payload column through `JSON.stringify` — so the text IS the value.
        insCell.run(rowId, colId, v != null ? "done" : "empty", v, null);
        dirty.push(cellId(rowId, colId));
      }
      inserted++;
    }
  });

  // Every record skipped is a delivery that stored nothing. Answering it as a success leaves the
  // sender posting the same wrong shape forever, and leaves its owner a green count for an
  // integration that has never delivered a value. Nothing was written, so there is nothing to
  // invalidate on the way out.
  if (skipped === records.length) {
    return refuse(
      source,
      `Nothing was stored — ${skipped} ${skipped === 1 ? "record" : "records"} skipped, ` +
        `${skipped === 1 ? "it carried none of the mapped fields" : "none of them carried any of the mapped fields"}.`,
      rawText,
    );
  }

  invalidateRowCount(source.sheetId);
  bumpDataVersion(source.sheetId);
  markSheetDirty(source.sheetId);
  markCellsDirty(dirty);

  // A webhook is the arrival most likely to repeat itself — senders retry, and the same record
  // arrives from two integrations. If the table asked for automatic dedupe, this is where it earns
  // its keep — rate-limited, because the sweep reads the whole table and the sender decides how
  // often this runs.
  const dedupedAfter = dedupeSoon(source.sheetId);

  const parts = [`${inserted} added, ${updated} updated.`];
  if (skipped > 0) parts.push(`${skipped} skipped — no mapped field matched.`);
  if (untouched > 0) {
    parts.push(`${untouched} ${untouched === 1 ? "row" : "rows"} unchanged — the mapped cells are pinned.`);
  }
  if (dedupedAfter > 0) {
    // Said as the TABLE's doing, not this delivery's. It removes duplicates from the whole table,
    // including rows that were here long before the integration was.
    parts.push(
      `The table's own duplicate rule then ran across every row and removed ` +
        `${dedupedAfter} ${dedupedAfter === 1 ? "row" : "rows"}.`,
    );
  }
  if (payloadColumnId != null) parts.push("Landed whole — pick fields out of it to make columns.");

  const note = parts.join(" ");
  recordDelivery(source.id, true, inserted + updated, note, rawText);
  return { ok: true, inserted, updated, dedupedAfter, note };
}
