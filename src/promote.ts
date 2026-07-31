// Promote a model column to a free rule.
//
// THE THING THIS IS FOR. A column that asks a model on every row is paying, forever, for an answer
// that is often not a judgement at all: the root domain of a website, a name split into two, a phone
// number in E.164, a title bucketed into a handful of levels. The model got those right because they
// are DERIVABLE, and anything derivable can be a rule that runs for nothing. Once the column has
// answered a few hundred rows, those answers are a worked example set — and a worked example set is
// exactly what you need to write the rule and, far more importantly, to check it.
//
// This is the piece a hosted tool structurally cannot copy. Somebody billing per enrichment has no
// reason to build the button that stops the enrichment being billed.
//
// ── The whole feature is the VERIFICATION, not the generation ────────────────────────────────────
//
// Asking a model to write a rule from examples is easy and worth nothing on its own, because the
// failure is silent: the rule looks plausible, it is approved, it runs over a million rows, and it is
// subtly wrong on the fifth of them nobody checked. So three things are measured before this offers
// anything, and all three are reported as numbers rather than as a verdict:
//
//   1. IT IS SCORED ON ROWS IT WAS NEVER SHOWN. The examples are split, the rule is written from one
//      half and graded on the other. A rule graded on the rows it was written from is a rule graded
//      on its own homework — and the highest-scoring answer to that exam is a lookup table.
//
//   2. MEMORISATION IS DETECTED, not hoped against. The characteristic failure of "write me a rule
//      from these examples" is a chain of if/else returning the literal answers. That scores 100% on
//      the training half, near zero on the other, and READS like a rule. Counting how many of the
//      observed answers appear verbatim in the code catches it directly, so it is named rather than
//      inferred from a bad score.
//
//   3. DISAGREEMENTS ARE SHOWN, up to a handful. "97% agreement" is a number nobody can act on; the
//      three rows where it differs are a thing a person can look at and say "the rule is right and
//      the model was wrong", which happens more often than you would think.
//
// Nothing here promotes anything. It measures, and the user decides.

/** One row the model already answered: what went in, and what came out. */
export interface Example {
  rowId: number;
  /** Input columns by name, as the generated rule will see them. */
  inputs: Record<string, string | null>;
  /** What the model produced, which is what the rule has to reproduce. */
  answer: string;
}

export interface Split {
  train: Example[];
  holdout: Example[];
}

/**
 * Below this many answered rows, promotion is not offered at all.
 *
 * Not a round number for its own sake. A rule written from a handful of examples is a rule written
 * from a handful of examples, and the holdout that grades it would be smaller still — an agreement
 * figure over eight rows is noise presented as a percentage, and the whole point of this feature is
 * that its numbers can be trusted.
 */
export const MIN_EXAMPLES = 40;

/** How many go to the model. The rest grade it. */
const TRAIN_FRACTION = 0.6;

/**
 * Split the examples into a half to learn from and a half to be graded on.
 *
 * INTERLEAVED, not cut down the middle. Rows arrive in insertion order, which on a real sheet means
 * grouped: one import, then another, then a webhook's worth. A straight cut hands the model one
 * source and grades it on a different one, so a rule that is right about everything scores badly and
 * a rule that is right about nothing occasionally scores well. Taking every Nth row spreads both
 * halves across whatever the sheet actually contains.
 *
 * Deterministic on purpose — no shuffling. The same examples must produce the same split every time,
 * or two people looking at the same column get different numbers and neither can be checked.
 */
export function splitExamples(examples: Example[]): Split {
  const train: Example[] = [];
  const holdout: Example[] = [];
  // 1 in every `step` rows is held out, so the train share lands near TRAIN_FRACTION.
  const step = Math.max(2, Math.round(1 / (1 - TRAIN_FRACTION)));
  examples.forEach((e, i) => ((i + 1) % step === 0 ? holdout : train).push(e));
  return { train, holdout };
}

export interface Agreement {
  /** Rows the rule was graded on. */
  checked: number;
  /** Rows where the rule produced exactly what the model did. */
  agreed: number;
  /** 0..1. `checked` of 0 reports 0 rather than dividing by nothing. */
  rate: number;
  /** Rows the rule threw on, counted separately — a crash is not a disagreement, it is a broken rule. */
  errored: number;
  /** A few of the actual differences, for a person to look at. */
  examples: Array<{ rowId: number; inputs: Record<string, string | null>; model: string; rule: string }>;
}

/** How many disagreements to carry back. Enough to see a pattern, not enough to become a wall. */
const SHOWN_DISAGREEMENTS = 5;

/**
 * Compare what the rule produced against what the model produced.
 *
 * Comparison is on TRIMMED TEXT, and that is a deliberate loosening: a rule returning "Acme" where
 * the model returned "Acme " is right, and counting it wrong would bury the real disagreements under
 * whitespace. Nothing more is normalised — case is not folded, because "US" and "us" landing in a
 * column somebody will group by is a genuine difference, and quietly calling it agreement is how a
 * rule gets promoted on a 98% that was really an 80%.
 */
export function scoreAgreement(
  holdout: Example[],
  produced: Map<number, { value: string | null; error?: string }>,
): Agreement {
  let agreed = 0;
  let errored = 0;
  const examples: Agreement["examples"] = [];

  for (const e of holdout) {
    const got = produced.get(e.rowId);
    // A row the rule never produced anything for is not agreement. Skipping absent rows instead of
    // counting them would let a rule score 100% by returning nothing at all.
    if (!got) { errored++; continue; }
    if (got.error) {
      errored++;
      if (examples.length < SHOWN_DISAGREEMENTS) {
        examples.push({ rowId: e.rowId, inputs: e.inputs, model: e.answer, rule: `error: ${got.error}` });
      }
      continue;
    }
    const rule = (got.value ?? "").trim();
    if (rule === e.answer.trim()) { agreed++; continue; }
    if (examples.length < SHOWN_DISAGREEMENTS) {
      examples.push({ rowId: e.rowId, inputs: e.inputs, model: e.answer, rule });
    }
  }

  return {
    checked: holdout.length,
    agreed,
    errored,
    rate: holdout.length > 0 ? agreed / holdout.length : 0,
    examples,
  };
}

export interface Memorisation {
  /** How many of the training answers appear verbatim in the code. */
  hits: number;
  /** Of how many distinct answers looked for. */
  looked: number;
  /** True when the code is carrying the answers rather than working them out. */
  memorised: boolean;
}

/**
 * Is this a rule, or a lookup table wearing one?
 *
 * The characteristic failure of "write me a rule from these examples": a chain of comparisons
 * returning the literal answers. It scores perfectly on the training half, near zero on anything
 * else, and reads exactly like a rule to someone skimming the code.
 *
 * Only DISTINCTIVE answers are looked for. A column of "yes"/"no" has two answers, both of which any
 * honest rule must contain — flagging that as memorisation would refuse every classifier ever
 * written. So short answers and answers shared by many rows are excluded, and what is left is the
 * long, specific, one-per-row values that a working rule has no reason to spell out.
 */
export function detectMemorisation(code: string, train: Example[]): Memorisation {
  const counts = new Map<string, number>();
  for (const e of train) {
    const a = e.answer.trim();
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }

  const distinctive = [...counts.entries()]
    // Longer than a label: "yes", "US", "B2B" are legitimate literals in real rules.
    .filter(([a]) => a.length >= 6)
    // And not a category. An answer shared by several rows is a bucket the rule is allowed to name.
    .filter(([, n]) => n === 1)
    .map(([a]) => a);

  if (distinctive.length === 0) return { hits: 0, looked: 0, memorised: false };

  const hay = code.toLowerCase();
  const hits = distinctive.filter((a) => hay.includes(a.toLowerCase())).length;

  return {
    hits,
    looked: distinctive.length,
    // A fifth of the one-off answers written into the code is not a coincidence. The threshold is
    // deliberately low: a rule has no reason to contain ANY of them, so the only question is how much
    // room to leave for one appearing inside an unrelated string.
    memorised: hits / distinctive.length >= 0.2,
  };
}

/**
 * Generated code arrives on ONE LINE, and a `//` comment in it kills everything after it.
 *
 * Measured, not guessed. The free design model returned a correct root-domain rule with its
 * indentation intact and every newline stripped — and three `// ...` comments inside it. On one line
 * a line comment runs to the end of the file, so the entire rest of the function was commented out
 * and it failed to parse with "Unexpected token ')'". The rule was RIGHT; only its formatting made it
 * unrunnable, and the report would have said "this column is doing something a rule cannot
 * reproduce", which is the opposite of true.
 *
 * A REGULAR EXPRESSION CANNOT DO THIS, which was the first attempt and was wrong. `//` appears inside
 * ordinary strings — `url.split('://')` is in the very rule that prompted this — so a pattern that
 * rewrites every `//` mangles the code it was meant to rescue, and the test caught it immediately
 * with "Unexpected token '*'". Telling a comment from a protocol needs to know whether you are inside
 * a quote, which needs a scanner.
 *
 * So this is a scanner: it walks the string tracking quotes and template literals, and only treats
 * `//` as a comment when it is outside all of them. What it finds it ENDS at the run of spaces this
 * model leaves where a newline was, which is what actually separates its statements. Anything it
 * cannot confidently place stays commented, and the code still runs.
 *
 * The model is also told not to write them — see the system prompt. This is the belt to that braces,
 * because "the model was asked nicely" is not a property anything should depend on.
 */
export function repairOneLineComments(code: string): string {
  if (code.includes("\n") || !code.includes("//")) return code;
  // A REGEX LITERAL also contains `//` — `/^https?:\/\//` is in the second rule this model produced,
  // and the scanner turned it into a comment exactly as the regex version had turned protocol strings
  // into one. Telling a regex from a division needs the preceding token, which needs a real parser.
  //
  // So the repair is no longer trusted to be right; it is only OFFERED. `chooseParsable` below
  // compiles both and keeps whichever actually works, which is a question with a definite answer and
  // does not require knowing anything about JavaScript's grammar.

  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;

    if (quote) {
      out += ch;
      // A backslash escapes the next character, including a closing quote.
      if (ch === "\\") { out += code[++i] ?? ""; continue; }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; continue; }

    if (ch === "/" && code[i + 1] === "/") {
      // A comment, outside any string. It runs to the double space standing in for the newline, or
      // to the end of the code if there is none.
      const rest = code.slice(i + 2);
      const end = rest.search(/\s{2,}/);
      const body = end === -1 ? rest : rest.slice(0, end);
      // `*/` inside the body would close the block early and break everything after it.
      out += `/*${body.replace(/\*\//g, "* /")}*/`;
      i += 1 + body.length;
      continue;
    }

    out += ch;
  }
  return out;
}

/**
 * Does this compile?
 *
 * `new Function` COMPILES the body and does not run it, which is exactly the question being asked and
 * none of the risk of asking it — the body is executed later, in the script runner's worker sandbox,
 * not here. Nothing else in this file executes anything.
 */
export function parses(code: string): boolean {
  try { new Function(code); return true; } catch { return false; }
}

/**
 * The original, or the repaired version, or nothing — decided by compiling them.
 *
 * Two attempts at repairing one-line code both broke it in a new way: a regular expression mangled
 * protocol strings, and a quote-aware scanner mangled regex literals. Both failures shared a cause —
 * each was CERTAIN it had improved the code and neither checked. Whether a string of JavaScript
 * compiles is a question with a definite answer, so it is asked instead of assumed, and the repair
 * became a suggestion rather than a claim.
 *
 * Returns null when neither compiles, which is a real outcome and reported as one rather than being
 * passed downstream to fail on every row and score zero.
 */
export function chooseParsable(code: string): string | null {
  if (parses(code)) return code;
  const repaired = repairOneLineComments(code);
  if (repaired !== code && parses(repaired)) return repaired;
  return null;
}

export type Verdict = "promote" | "close" | "no";

export interface PromotionReport {
  agreement: Agreement;
  memorisation: Memorisation;
  verdict: Verdict;
  /** The verdict in the user's words, with the numbers in it. */
  summary: string;
}

/**
 * The three thresholds, and why they are where they are.
 *
 * A promoted rule replaces a model on every future row, so being wrong is not a one-off — it is a
 * wrong value on every row from now on, in a column nobody re-checks because it used to be right.
 * That asymmetry is why the bar is high and why "close" exists as its own answer rather than being
 * rounded up into a yes.
 */
const PROMOTE_AT = 0.98;
const CLOSE_AT = 0.9;

export function judge(agreement: Agreement, memorisation: Memorisation): PromotionReport {
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  // Memorisation OVERRIDES the score, and this ordering is the point. A memorised rule can post a
  // high number — if the split happened to be kind, or the column has few distinct answers — and
  // promoting on that score would ship a lookup table that returns nothing for every row the sheet
  // has not seen yet.
  if (memorisation.memorised) {
    return {
      agreement, memorisation, verdict: "no",
      summary:
        `This is not a rule — it has the answers written into it (${memorisation.hits} of ` +
        `${memorisation.looked} one-off answers appear in the code word for word). It would work on ` +
        `the rows it was shown and return nothing useful for new ones.`,
    };
  }

  if (agreement.checked === 0) {
    return {
      agreement, memorisation, verdict: "no",
      summary: "There were no rows left over to check the rule against, so there is nothing to judge it on.",
    };
  }

  if (agreement.rate >= PROMOTE_AT) {
    return {
      agreement, memorisation, verdict: "promote",
      summary:
        `The rule matched the model on ${agreement.agreed} of ${agreement.checked} rows it had never ` +
        `seen (${pct(agreement.rate)}). Switching to it makes this column free from now on.`,
    };
  }

  if (agreement.rate >= CLOSE_AT) {
    return {
      agreement, memorisation, verdict: "close",
      summary:
        `The rule matched on ${agreement.agreed} of ${agreement.checked} unseen rows ` +
        `(${pct(agreement.rate)}) — close, but not close enough to hand the column over unread. ` +
        `Look at where it differs: sometimes the rule is right and the model was not.`,
    };
  }

  return {
    agreement, memorisation, verdict: "no",
    summary:
      `The rule only matched on ${agreement.agreed} of ${agreement.checked} unseen rows ` +
      `(${pct(agreement.rate)})${agreement.errored > 0 ? `, and broke on ${agreement.errored}` : ""}. ` +
      `This column is doing something a rule cannot reproduce — which is the case for keeping it on a model.`,
  };
}
