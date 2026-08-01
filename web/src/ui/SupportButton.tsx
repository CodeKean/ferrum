// A way to reach a person, from inside the app.
//
// Ferrum runs on your own machine with no account and no dashboard, which means there is nowhere
// else for "this is not doing what I expected" to go. A link in a README is read once, at install;
// this is there at the moment something is confusing.
//
// ── Two decisions worth not re-litigating ──────────────────────────────────────────────────────
//
// It is NOT WhatsApp green. The glyph is what makes this recognisable, and the only green in an
// otherwise graphite-and-patina app would read as something bolted on — which is exactly what a
// vendor-coloured floating button usually is. It takes `--primary`, like every other affirmative
// control here.
//
// It is NOT a circle. A round floating action button is a shape this app uses nowhere else;
// `--r-sm` is described in the tokens as "the signature radius: buttons, inputs, selects", so this
// is a button like the others, that happens to float.
//
// The glyph carries it with no word beside it, which is only acceptable because WhatsApp's mark is
// one of the few that is genuinely read as its own name. What that costs is a control whose meaning
// is invisible to a screen reader and to anyone who does not know the mark, so the `aria-label` and
// the `title` are not decoration here — they are the label, and neither may be dropped.

import { supportLink } from "./supportLink.ts";
import "./SupportButton.css";

export function SupportButton() {
  return (
    <a
      className="cc-support"
      href={supportLink()}
      // Opens away from the app: a run in progress must not be navigated out from under someone.
      // `noopener` because the opened page gets a handle on this window without it.
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Ask for help on WhatsApp"
      title="Ask for help on WhatsApp — opens a chat in a new tab"
    >
      <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.15h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.17 8.17 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.24 8.23Zm4.52-6.16c-.25-.13-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.97-.15.16-.29.18-.54.06-.25-.13-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.38-1.72-.15-.25-.02-.38.11-.5.11-.11.25-.29.37-.44.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.13-.56-1.35-.77-1.85-.2-.48-.41-.42-.56-.42-.14-.01-.31-.01-.47-.01-.17 0-.43.06-.66.31-.22.25-.87.85-.87 2.07 0 1.22.89 2.4 1.02 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.47-.07 1.47-.6 1.68-1.18.2-.58.2-1.08.14-1.18-.06-.11-.22-.17-.47-.29Z" />
      </svg>
    </a>
  );
}
