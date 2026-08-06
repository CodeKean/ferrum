// Is this column actually set up to produce anything?
//
// Every lane already answers this at RUN time, and answers it well: an unconfigured column skips its
// rows rather than erroring them, because a blank prompt is the column's fault and not the row's, and
// marking a million rows red would bury every real failure underneath.
//
// What nobody answered is the same question BEFORE the run. A column with no instruction was offered
// in the confirmation as an ordinary priced run — rows, cells, a dollar figure — and then skipped
// every row. On five rows that is a curiosity; on two hundred thousand it is a wait for nothing, with
// no explanation on the one screen whose whole job is to say what a run will do.
//
// So the test lives here, once, and both ends ask it. The wording of each reason is deliberately the
// same fact the executor reports on the cell, so the warning before the run and the note on the cell
// after it do not read as two different problems.

import type { Column } from "./types.ts";

/**
 * Why this column would produce nothing, or null when it is ready to run.
 *
 * Conservative by design: it reports only what is CERTAIN to skip every row, never a guess about a
 * configuration that might work. A false warning on the spend screen is worse than none, because it
 * is the warnings people stop reading that make the real one invisible.
 */
export function notReadyReason(col: Pick<Column,
  | "kind" | "prompt" | "transformScriptId" | "httpConfig" | "mcpConfig" | "sendConfig"
  | "waterfall" | "relationId" | "lookupColumnId" | "rollup"
>): string | null {
  switch (col.kind) {
    // Typed in or imported, and a wait holds a row for a while. Neither produces a value from a
    // configuration, so neither can be missing one.
    case "static":
    case "wait":
      return null;

    case "ai":
    case "agent":
      return (col.prompt ?? "").trim() ? null : "no instruction yet";

    case "script":
      return col.transformScriptId ? null : "no rule saved yet";

    case "http": {
      const url = (col.httpConfig as { url?: unknown } | undefined)?.url;
      return typeof url === "string" && url.trim() ? null : "no address yet";
    }

    case "mcp": {
      const cfg = (col.mcpConfig ?? {}) as { serverId?: unknown; tool?: unknown };
      if (!cfg.serverId) return "no connected app chosen yet";
      return cfg.tool ? null : "no tool chosen yet";
    }

    case "send": {
      const cfg = (col.sendConfig ?? {}) as { targetSheetId?: unknown };
      return cfg.targetSheetId ? null : "no destination table yet";
    }

    case "lookup":
      if (!col.relationId) return "not linked to another table yet";
      return col.lookupColumnId ? null : "no field chosen to read";

    case "rollup": {
      if (!col.relationId) return "not linked to another table yet";
      const fn = (col.rollup as { fn?: unknown } | undefined)?.fn;
      return fn ? null : "no calculation chosen yet";
    }

    case "waterfall": {
      // Counted the way the executor counts them: a step that is switched off is not a step it will
      // run, so a waterfall whose every step is disabled has nothing to do and says so.
      const steps = parseSteps(col.waterfall);
      if (steps === null) return "its steps could not be read";
      return steps > 0 ? null : "no steps yet";
    }

    default:
      return null;
  }
}

/** Enabled steps in a stored waterfall, or null when the JSON cannot be read at all. */
function parseSteps(raw: string | null | undefined): number | null {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { steps?: Array<{ enabled?: unknown }> };
    const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    // `enabled` absent means on — that is how a step written before the switch existed behaves, and
    // reading it as off would report a working column as empty.
    return steps.filter((s) => s?.enabled !== false).length;
  } catch {
    return null;
  }
}
