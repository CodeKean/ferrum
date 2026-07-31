// Your own account.
//
// Three things, and each is here because it has nowhere else to be: your name (so other people know
// who did what), your password, and the list of browsers you are signed in on — which is the only
// way to end a session on a machine you no longer have.

import { useCallback, useEffect, useState } from "react";
import { session, type DeviceSession, type SessionState } from "../api.ts";
import { Modal } from "../ui/Modal.tsx";
import "./Account.css";

/** A user-agent string, shortened to the two facts anybody recognises their own session by. */
function device(ua: string): string {
  if (!ua) return "Unknown browser";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const os =
    /Windows/.test(ua) ? "Windows"
    : /Macintosh|Mac OS/.test(ua) ? "Mac"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
}

const when = (iso: string): string => {
  const t = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z")).getTime();
  if (!Number.isFinite(t)) return "unknown";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 2) return "active now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? "" : "s"} ago`;
};

interface Props {
  me: SessionState;
  onSessionChanged: () => void;
}

export function Account({ me, onSessionChanged }: Props) {
  const [name, setName] = useState(me.person?.name ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [devices, setDevices] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);

  const loadDevices = useCallback(async () => {
    try {
      setDevices((await session.devices()).sessions);
    } catch {
      // Not worth an error line: the rest of this screen still works, and the list is informational.
      setDevices([]);
    }
  }, []);

  useEffect(() => { void loadDevices(); }, [loadDevices]);
  useEffect(() => { setName(me.person?.name ?? ""); }, [me.person?.name]);

  const run = async (fn: () => Promise<unknown>, said: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      setNote(said);
      onSessionChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!me.person) return null;

  return (
    <section className="cc-acct">
      <header>
        <h2 className="cc-acct__h2">Your account</h2>
        <p className="cc-acct__blurb">
          {/* Written out per role rather than patched with an article. "a owner" was the first
              version, and the owner is THE owner — there is only ever one, so "a" was wrong twice. */}
          Signed in as {me.person.email} — {
            me.person.role === "owner" ? "you own this instance"
            : me.person.role === "admin" ? "an admin"
            : me.person.role === "member" ? "a member"
            : "read-only"
          }.
        </p>
      </header>

      {/* Both lines held open, so nothing on this screen moves when one appears. */}
      <p className="cc-acct__error" role="alert">{error ?? ""}</p>
      <p className="cc-acct__note" role="status">{note ?? ""}</p>

      <div className="cc-acct__block">
        <label className="cc-acct__row" htmlFor="cc-acct-name">
          <span className="cc-acct__label">Your name</span>
          <input
            id="cc-acct-name"
            className="cc-acct__input"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name !== me.person?.name) void run(() => session.updateMe({ name }), "Saved."); }}
            placeholder="So other people know who did what"
          />
        </label>
      </div>

      <div className="cc-acct__block">
        <h3 className="cc-acct__h3">Change your password</h3>
        <p className="cc-acct__hint">
          Your current password is asked for even though you are already signed in — an unattended
          screen is how an account gets taken over, and this is the change that locks you out of your
          own. Everywhere else you are signed in is ended; this browser stays.
        </p>
        <label className="cc-acct__row" htmlFor="cc-acct-cur">
          <span className="cc-acct__label">Current password</span>
          <input id="cc-acct-cur" className="cc-acct__input" type="password" autoComplete="current-password"
            value={current} disabled={busy} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="cc-acct__row" htmlFor="cc-acct-new">
          <span className="cc-acct__label">New password</span>
          <input id="cc-acct-new" className="cc-acct__input" type="password" autoComplete="new-password"
            value={next} disabled={busy} onChange={(e) => setNext(e.target.value)} />
        </label>
        <div className="cc-acct__act">
          <button
            className="cc-btn cc-btn--primary"
            disabled={busy || next.length < 10 || current.length === 0}
            onClick={() => void run(
              async () => { await session.updateMe({ password: next, currentPassword: current }); setCurrent(""); setNext(""); await loadDevices(); },
              "Password changed. Every other browser has been signed out.",
            )}
          >
            Change it
          </button>
          <span className="cc-acct__len">
            {next.length === 0 ? "At least 10 characters." : next.length < 10 ? `${10 - next.length} more to go.` : "Long enough."}
          </span>
        </div>
      </div>

      <div className="cc-acct__block">
        <h3 className="cc-acct__h3">Where you are signed in</h3>
        <ul className="cc-acct__devices">
          {devices == null && [0, 1].map((i) => (
            <li key={`s${i}`} className="cc-acct__device"><span className="cc-acct__skel" /></li>
          ))}
          {devices?.map((d) => (
            <li key={d.id} className="cc-acct__device">
              <span className="cc-acct__dname truncate">{device(d.userAgent)}</span>
              <span className="cc-acct__dwhen">{when(d.lastSeenAt)}</span>
              <span className="cc-acct__dtag">{d.current ? "this browser" : ""}</span>
            </li>
          ))}
          {devices?.length === 0 && <li className="cc-acct__device cc-acct__device--none">Only this browser.</li>}
        </ul>
        <div className="cc-acct__act">
          <button
            className="cc-btn"
            disabled={busy || (devices?.length ?? 0) < 2}
            onClick={() => setConfirmSignOutAll(true)}
            title={(devices?.length ?? 0) < 2 ? "There is nowhere else to sign out of." : "End every other session"}
          >
            Sign out everywhere else
          </button>
        </div>
      </div>

      <div className="cc-acct__block">
        <button
          className="cc-btn cc-btn--danger"
          disabled={busy}
          onClick={() => void session.signOut().then(() => window.location.reload())}
        >
          Sign out
        </button>
      </div>

      <Modal open={confirmSignOutAll} onClose={() => setConfirmSignOutAll(false)} title="Sign out everywhere else?">
        <p className="cc-acct__hint">
          Every other browser you are signed in on will be signed out immediately. This one stays.
        </p>
        <div className="cc-acct__modalfoot">
          <button className="cc-btn" onClick={() => setConfirmSignOutAll(false)}>Cancel</button>
          <button
            className="cc-btn cc-btn--primary"
            disabled={busy}
            onClick={() => {
              setConfirmSignOutAll(false);
              void run(async () => { await session.endOtherDevices(); await loadDevices(); }, "Signed out everywhere else.");
            }}
          >
            Sign them out
          </button>
        </div>
      </Modal>
    </section>
  );
}
