// Keeping secrets out of the things that outlive the request.
//
// An error message is the one string in this app that is built from someone else's output and then
// KEPT. A failed call turns into `cells.error_msg`, into a `cell_attempts` row, and onto every open
// SSE subscriber — so anything a provider echoes back is persisted and broadcast.
//
// The realistic path is not an exotic one. An HTTP column's URL is written by the user, and putting
// a key in a query parameter is how a great many APIs document themselves (`?api_key=...`). When
// that request fails, the message names the URL it failed on. The key is then sitting in the
// database, in a file that gets backed up, copied to another machine, or handed over when someone
// asks what went wrong. A provider's 401 body can carry the credential straight back too.
//
// The review's own coverage critic flagged this: "no route returns a token or key" had only been
// checked for route RESPONSES, and error text reaching subscribers through the bus was never looked
// at. This is that gap closed.
//
// Two layers, and both are needed. The PATTERNS below catch credential shapes this process has
// never seen — a key typed straight into a column, one echoed back by a provider — each anchored on
// a delimiter so it cannot run past the value. But a key from a small API is often a bare blob with
// no prefix and nothing named beside it, which no pattern can tell from a request id. Those the user
// has stored under a name, so they are ALSO matched exactly. See registerSecretValues.

/**
 * Every pattern is `[what it catches, what it leaves behind]`. The replacement always keeps enough
 * of the surrounding text for the message to stay diagnosable — "401 on
 * https://api.example.com/v1/find?api_key=***" still tells you which call failed and why, which is
 * the entire reason the message is kept. Redaction that destroys the message just moves the problem.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // Provider keys by their published prefixes. `sk-or-v1-` (OpenRouter), `sk-ant-` (Anthropic) and
  // bare `sk-` (OpenAI and the many APIs that copied it) all run until a non-key character.
  [/\b(sk-(?:or-v1-|ant-(?:api\d\d-)?|proj-)?)[A-Za-z0-9_-]{12,}/g, "$1***"],
  // Google / GCP.
  [/\bAIza[A-Za-z0-9_-]{16,}/g, "AIza***"],
  // An Authorization header, however it was spelled. The scheme is kept: "Bearer ***" and
  // "Basic ***" are different failures and the difference is worth reading.
  [/\b(Authorization\s*[:=]\s*)(\w+\s+)?\S+/gi, "$1$2***"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  // Anything that NAMES itself a secret in a query string or a header. This is the one that catches
  // the user's own HTTP column, because it matches on the parameter name rather than on the shape of
  // the value — a key with no recognisable prefix is still caught.
  [/\b((?:api[-_]?key|apikey|access[-_]?token|auth[-_]?token|secret|password|passwd|pwd|token|key|sig|signature)\s*[:=]\s*)(?:"|')?[^&\s"'<>|]{6,}/gi, "$1***"],
  // The webhook token IS the credential and it is the whole path segment, so a message naming the
  // ingest URL hands over the ability to write into the sheet.
  [/(\/hook\/)[A-Za-z0-9_-]{8,}/g, "$1***"],
  // A userinfo credential in a URL: https://user:password@host.
  [/(\/\/[^/\s:@]+:)[^/\s@]+(@)/g, "$1***$2"],
];

/**
 * Exact values this process knows are secret, longest first.
 *
 * The patterns above are the right default because they catch keys this process has never seen —
 * one typed straight into a column, one echoed back by a provider. What they cannot catch is a key
 * with no recognisable shape: plenty of small APIs issue a bare hex blob, and no pattern can tell
 * that from a request id. Those we KNOW, because the user stored them under a name, so they are
 * matched exactly.
 *
 * Longest first so a key that contains another as a prefix cannot be half-replaced, leaving the
 * remainder of the longer one in the text.
 *
 * Held as a module-level list rather than passed in, because the redactor is called from the error
 * path of everything and threading a secret store through all of it would be its own hazard.
 */
let exactValues: string[] = [];

export function registerSecretValues(values: string[]): void {
  exactValues = [...new Set(values.filter((v) => typeof v === "string" && v.length >= 8))]
    .sort((a, b) => b.length - a.length);
}

/** Escape everything the regex engine treats as syntax — a key may contain any character at all. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Strip anything credential-shaped out of a string that is about to be stored or broadcast.
 *
 * Deliberately cheap and non-throwing. It runs on every errored cell of every flush, and an error
 * message that fails to render because the redactor threw would be a worse outcome than the one it
 * is guarding against.
 */
export function redactSecrets(text: string): string;
export function redactSecrets(text: null | undefined): null;
export function redactSecrets(text: string | null | undefined): string | null;
export function redactSecrets(text: string | null | undefined): string | null {
  if (!text) return text == null ? null : text;
  let out = text;
  // Exact values FIRST. A stored key that also matches a pattern would otherwise be partially
  // rewritten by the pattern, and the leftover would no longer match the exact value.
  for (const v of exactValues) {
    if (out.includes(v)) out = out.replace(new RegExp(escapeRe(v), "g"), "***");
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * True when redaction changed anything.
 *
 * Used to decide whether to tell the user their message was edited. A message that silently loses a
 * substring is confusing in a different way — someone comparing it to their provider's dashboard
 * needs to know why the two do not match.
 */
export function wasRedacted(original: string | null | undefined): boolean {
  return !!original && redactSecrets(original) !== original;
}
