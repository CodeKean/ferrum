// What a referenced column actually holds.
//
// A reference names a column, and a name is not evidence. `/Domain` on a list someone else built
// might hold `acme.com`, or `https://www.acme.com/`, or a company name, or nothing at all — and the
// difference decides whether a prompt over a million rows returns answers or apologies. Every one of
// those is obvious from three rows of real values and invisible from the name.
//
// So hovering a reference shows the first rows of that column. Fetched on hover rather than up
// front: a template can reference a dozen columns and nobody looks at more than one or two.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./RefPreview.css";

interface Row { row: number; value: string | null }

/** Cached for the life of the page. Hovering the same chip twice must not be two requests. */
const cache = new Map<string, Row[]>();

export function RefPreview({ columnId, name, rect }: { columnId: string; name: string; rect: DOMRect }) {
  const [rows, setRows] = useState<Row[] | null>(() => cache.get(columnId) ?? null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cache.has(columnId)) { setRows(cache.get(columnId)!); return; }
    let dead = false;
    // A short delay, so sweeping the pointer across a sentence full of references does not fire a
    // request per chip passed over.
    const t = setTimeout(() => {
      void fetch(`/api/columns/${columnId}/preview?limit=10`)
        .then((r) => r.json())
        .then((r) => {
          if (dead || r.error) return;
          cache.set(columnId, r.values ?? []);
          setRows(r.values ?? []);
        })
        .catch(() => { /* no preview is a fine outcome; a wrong one is not */ });
    }, 160);
    return () => { dead = true; clearTimeout(t); };
  }, [columnId]);

  // Above the chip when there is no room below, so a reference near the bottom of a drawer is not
  // previewed off-screen.
  const below = rect.bottom + 8;
  const flip = below + 240 > window.innerHeight && rect.top > 260;
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 300)),
    ...(flip ? { bottom: window.innerHeight - rect.top + 8 } : { top: below }),
  };

  return createPortal(
    <div className="cc-refprev" ref={box} style={style} role="tooltip">
      <div className="cc-refprev__head">
        <span className="cc-refprev__name">{name}</span>
      </div>
      {rows == null ? (
        // A fixed-height placeholder, so the box does not resize under the pointer the instant the
        // values land — which on a hover card reads as a flicker.
        <div className="cc-refprev__skel" />
      ) : rows.length === 0 ? (
        <p className="cc-refprev__none">This table has no rows yet.</p>
      ) : (
        <table className="cc-refprev__table">
          <thead>
            <tr><th scope="col">Row</th><th scope="col">Value</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.row}>
                <td className="cc-refprev__n">{r.row}</td>
                {/* An empty cell is called empty rather than drawn as a blank line — "this column is
                    full of blanks" is the single most useful thing this card can tell you. */}
                <td className="cc-refprev__v">
                  {r.value ? r.value : <span className="cc-refprev__empty">empty</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>,
    document.body,
  );
}
