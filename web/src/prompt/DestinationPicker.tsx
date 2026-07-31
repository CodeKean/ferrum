// "Start from a destination."
//
// Collapsed to a single button, because it is a one-time action at the START of configuring a column
// and dead weight on every visit after that — a permanently-expanded gallery of eight providers
// above a form you have already filled in is the same mistake as a describe-it panel on every tab.
//
// What it applies is a filled-in form, and it says so. It also says what is still missing, because a
// preset that leaves the campaign id blank and looks finished is worse than one that admits it.

import { useState } from "react";
import { DESTINATIONS, type Destination } from "./destinations.ts";
import { IconPlus } from "../ui/Icon.tsx";
import "./DestinationPicker.css";

export function DestinationPicker({ onPick, disabled }: { onPick: (d: Destination) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<Destination | null>(null);

  if (!open) {
    return (
      <button
        className="cc-btn cc-btn--ghost cc-btn--sm cc-dest__open"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <IconPlus /> <span>Start from a destination</span>
      </button>
    );
  }

  return (
    <div className="cc-dest">
      <div className="cc-dest__head">
        <span className="cc-dest__title">Start from a destination</span>
        <button className="cc-linkish" onClick={() => { setOpen(false); setConfirming(null); }}>Close</button>
      </div>

      {/* Said once, at the top, rather than repeated on eight cards. It is the honest framing of what
          these are and it is what stops someone treating a stale endpoint as this app's fault. */}
      <p className="cc-dest__note">
        Each of these fills in the form below from the provider's public documentation, and everything
        stays editable afterwards. They are a head start, not a guarantee — check the endpoint against
        the provider's own docs before you run a column on ten thousand rows.
      </p>

      <div className="cc-dest__grid">
        {DESTINATIONS.map((d) => (
          <button
            key={d.id}
            className={`cc-dest__card${confirming?.id === d.id ? " cc-dest__card--on" : ""}`}
            disabled={disabled}
            onClick={() => setConfirming(d)}
          >
            <span className="cc-dest__name truncate">{d.name}</span>
            <span className="cc-dest__group">{d.group}</span>
            <span className="cc-dest__what">{d.what}</span>
          </button>
        ))}
      </div>

      {confirming && (
        <div className="cc-dest__confirm">
          <p className="cc-dest__cwhat">{confirming.what}</p>

          {/* What is NOT done. A form that looks configured and silently posts an empty campaign id
              is the failure this list exists to prevent. */}
          {confirming.fillIn.length > 0 && (
            <div className="cc-dest__todo">
              <span className="cc-dest__todolabel">You still need to:</span>
              <ul>{confirming.fillIn.map((f) => <li key={f}>{f}</li>)}</ul>
            </div>
          )}

          {confirming.needsKey && (
            <p className="cc-dest__key">
              The key travels as <code>{`{{secret:${confirming.needsKey}}}`}</code> — a reference to a
              key saved in Settings, never the key itself. Save one under that exact name first, or
              every row will be refused before it is sent.
            </p>
          )}

          <div className="cc-dest__actions">
            <button
              className="cc-btn cc-btn--primary cc-btn--sm"
              disabled={disabled}
              onClick={() => { onPick(confirming); setOpen(false); setConfirming(null); }}
            >
              Fill in the form
            </button>
            {confirming.docsUrl && (
              // A new tab, and rel-guarded — the house rule for every external link.
              <a className="cc-linkish" href={confirming.docsUrl} target="_blank" rel="noopener noreferrer">
                Read the provider's docs
              </a>
            )}
            <span className="cc-dest__checked mono">written down {confirming.checked}</span>
          </div>
        </div>
      )}
    </div>
  );
}
