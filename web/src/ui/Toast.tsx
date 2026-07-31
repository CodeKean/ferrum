// A brief confirmation that something happened.
//
// For actions whose whole result is "it worked" — a refresh that touched 412 rows, a copy, a
// no-op that is worth reporting as a no-op. Anything the user has to act on belongs in a dialog or
// an inline error, not here: a message that disappears on a timer cannot carry a decision.

import { useEffect, useRef, useState } from "react";
import "./Toast.css";

const VISIBLE_MS = 3200;

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  // Mounted separately from `message` so the exit animation has something to play against — clearing
  // the message immediately would unmount the node mid-transition, which is the instant-disappear
  // the motion rules call out.
  const [shown, setShown] = useState(false);
  // The app passes a new inline arrow every render, and during a run the SSE handlers re-render it
  // several times a second. With `onDone` in the dependency list the effect tore both timers down
  // and restarted them on every one of those renders, so the 3,200ms countdown never completed and
  // a transient confirmation stayed on screen for the whole run. The handler goes in a ref so the
  // effect can depend on the MESSAGE alone.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!message) return;
    setShown(true);
    const hide = setTimeout(() => setShown(false), VISIBLE_MS);
    // Cleared after the exit transition, not with it.
    const clear = setTimeout(() => doneRef.current(), VISIBLE_MS + 220);
    return () => { clearTimeout(hide); clearTimeout(clear); };
  }, [message]);

  if (!message) return null;

  return (
    <div className={`cc-toast${shown ? " cc-toast--in" : ""}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}
