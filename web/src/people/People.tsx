// Who is on this instance.
//
// A settings section rather than its own page, because it belongs with the other decisions that
// affect everyone — the keys, the budgets, the default model. Only an admin sees it; the server
// refuses the route outright, so this component is never rendered without the right to read it.
//
// ── Why the invite link is shown rather than emailed ────────────────────────────────────────────
//
// There is no mail server here, and adding one would mean this instance needs outbound credentials
// that can expire, be rate-limited, or land in a spam folder nobody checks. So the admin copies a
// link and sends it however they already talk to that person. The cost is honest and stated on the
// screen: the link is shown ONCE, because only its hash is kept.

import { useCallback, useEffect, useState } from "react";
import { session, type PendingInvite, type Person, type Role, type SessionState } from "../api.ts";
import { Select } from "../ui/Select.tsx";
import { Modal } from "../ui/Modal.tsx";
import { IconTrash, IconCheck } from "../ui/Icon.tsx";
import "./People.css";

/** What each rung actually means, in the words someone choosing between them needs. */
const ROLE_NOTE: Record<Role, string> = {
  viewer: "Can look at everything. Cannot change a cell and cannot start a run.",
  member: "Can build tables and run columns. Running spends money.",
  admin: "All of that, plus the keys, the budgets and this list.",
  owner: "Owns this instance. There is only ever one.",
};

const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

/** "2 days ago" — a date on this screen is only ever read as "recently or not". */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z")).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days < 31 ? `${days} day${days === 1 ? "" : "s"} ago` : `${Math.round(days / 30)} months ago`;
}

interface Props {
  me: SessionState;
  /** Re-read after anything that could change what the current person may do. */
  onSessionChanged: () => void;
}

export function People({ me, onSessionChanged }: Props) {
  const [people, setPeople] = useState<Person[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  /** The one-time link, held until it is dismissed. There is no way to see it again. */
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Person | null>(null);
  const [confirmHandover, setConfirmHandover] = useState<Person | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await session.people();
      setPeople(r.people);
      setInvites(r.invites);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Every mutation goes through here, so one place holds the busy flag and the error line. */
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const invite = async () => {
    await run(async () => {
      const r = await session.invite(inviteEmail.trim(), inviteRole);
      setFreshLink(`${window.location.origin}${r.link}`);
      setInviteEmail("");
      setCopied(false);
    });
  };

  const copyLink = async () => {
    if (!freshLink) return;
    try {
      await navigator.clipboard.writeText(freshLink);
      setCopied(true);
    } catch {
      // Clipboard access can be refused. The link is on screen and selectable either way, so this
      // is a convenience failing rather than the feature failing — say nothing and let them select.
      setCopied(false);
    }
  };

  const iAmOwner = me.person?.role === "owner";

  return (
    <section className="cc-people">
      <header className="cc-people__head">
        <div>
          <h2 className="cc-people__h2">People</h2>
          <p className="cc-people__blurb">
            Everyone who can sign in here. A viewer cannot start a run, which matters more than it
            sounds: running is the only thing in Ferrum that spends money.
          </p>
        </div>
        {/* Shrunk to its content and pinned right — the count is short and a stretched box beside it
            would be the dead space this codebase keeps deleting. */}
        <span className="cc-people__count">
          {loaded ? `${people.filter((p) => !p.disabled).length} active` : " "}
        </span>
      </header>

      <p className="cc-people__error" role="alert">{error ?? ""}</p>

      {/* ── invite ────────────────────────────────────────────────────────────────────────────── */}
      <div className="cc-people__invite">
        <input
          className="cc-people__input"
          type="email"
          placeholder="someone@company.com"
          value={inviteEmail}
          disabled={busy}
          onChange={(e) => setInviteEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && inviteEmail.trim()) void invite(); }}
          aria-label="Email address to invite"
        />
        <Select
          label="Role"
          value={inviteRole}
          options={ROLE_OPTIONS}
          onChange={(v) => setInviteRole(v as Role)}
          size="sm"
          aria-label="What they will be able to do"
        />
        <button className="cc-btn cc-btn--primary" disabled={busy || !inviteEmail.trim()} onClick={() => void invite()}>
          + Invitation
        </button>
      </div>
      <p className="cc-people__note">{ROLE_NOTE[inviteRole]}</p>

      {invites.length > 0 && (
        <ul className="cc-people__pending">
          {invites.map((i) => (
            <li key={i.email} className="cc-people__pendrow">
              <span className="cc-people__pendmail truncate">{i.email}</span>
              <span className="cc-people__pendrole">invited as {i.role}</span>
              <button
                className="cc-people__icon"
                title={`Take back the invitation to ${i.email}`}
                aria-label={`Take back the invitation to ${i.email}`}
                disabled={busy}
                onClick={() => void run(() => session.revokeInvite(i.email))}
              >
                <IconTrash />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ── the list ──────────────────────────────────────────────────────────────────────────── */}
      {/* The table scrolls inside its own box rather than pushing the PAGE sideways. Three of these
          columns hold controls that cannot usefully shrink, so on a narrow screen something has to
          scroll — and the one thing that must not is the body. */}
      <div className="cc-people__scroll">
      <table className="cc-people__table">
        <thead>
          <tr>
            <th>Person</th>
            <th className="cc-people__c-role">Role</th>
            <th className="cc-people__c-seen">Last seen</th>
            <th className="cc-people__c-act"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {!loaded && (
            // Fixed-height skeletons rather than nothing, so the table does not snap taller when the
            // list lands.
            [0, 1, 2].map((i) => (
              <tr key={`s${i}`} className="cc-people__row"><td colSpan={4}><span className="cc-people__skel" /></td></tr>
            ))
          )}
          {loaded && people.map((p) => {
            const isMe = p.id === me.person?.id;
            const isOwner = p.role === "owner";
            // Mirrors mayManage/mayRemove on the server. The server is the enforcer — this only
            // decides whether to offer a control that would be refused.
            const canChangeRole = !isMe && (!isOwner || iAmOwner);
            const canRemove = !isMe && !isOwner;
            return (
              <tr key={p.id} className={`cc-people__row${p.disabled ? " cc-people__row--off" : ""}`}>
                <td>
                  {/* Name and its pills on ONE line, the address under it. The pills were siblings of
                      a block-level address, so each one dropped to a third line — the wasteful
                      stacking this codebase keeps deleting, in the row that shows it off. */}
                  <span className="cc-people__line">
                    <span className="cc-people__name truncate">{p.name || p.email}</span>
                    {isMe && <span className="cc-people__you">you</span>}
                    {p.disabled && <span className="cc-people__off">suspended</span>}
                  </span>
                  {p.name && <span className="cc-people__mail truncate">{p.email}</span>}
                </td>
                <td className="cc-people__c-role">
                  {isOwner ? (
                    <span className="cc-people__owner">Owner</span>
                  ) : canChangeRole ? (
                    <Select
                      label="Role"
                      value={p.role}
                      options={ROLE_OPTIONS}
                      size="sm"
                      onChange={(v) => void run(() => session.setRole(p.id, v as Role), onSessionChanged)}
                      aria-label={`What ${p.email} can do`}
                    />
                  ) : (
                    <span className="cc-people__rolefixed">{p.role}</span>
                  )}
                </td>
                <td className="cc-people__c-seen">{ago(p.lastSeenAt)}</td>
                <td className="cc-people__c-act">
                  {iAmOwner && !isOwner && !p.disabled && (
                    <button
                      className="cc-people__link"
                      disabled={busy}
                      onClick={() => setConfirmHandover(p)}
                      title="Make this person the owner. You become an admin."
                    >
                      Hand over
                    </button>
                  )}
                  {canRemove && (
                    <>
                      <button
                        className="cc-people__link"
                        disabled={busy}
                        onClick={() => void run(() => session.setDisabled(p.id, !p.disabled))}
                        title={p.disabled
                          ? "Let them sign in again."
                          : "Sign them out everywhere and stop them signing back in. Their work stays."}
                      >
                        {p.disabled ? "Restore" : "Suspend"}
                      </button>
                      <button
                        className="cc-people__icon"
                        disabled={busy}
                        onClick={() => setConfirmRemove(p)}
                        title={`Remove ${p.email}`}
                        aria-label={`Remove ${p.email}`}
                      >
                        <IconTrash />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {/* ── the link, shown once ──────────────────────────────────────────────────────────────── */}
      <Modal open={freshLink != null} onClose={() => setFreshLink(null)} title="Send them this link">
        <p className="cc-people__modaltext">
          This is the only time it is shown — only a scrambled copy is kept here, so it cannot be
          looked up again. Send it however you normally talk to them. It works once, and stops
          working after seven days.
        </p>
        <div className="cc-people__linkrow">
          <input className="cc-people__input cc-people__linkinput" readOnly value={freshLink ?? ""} onFocus={(e) => e.currentTarget.select()} />
          <button className="cc-btn cc-btn--primary" onClick={() => void copyLink()}>
            {copied ? <><IconCheck /> Copied</> : "Copy"}
          </button>
        </div>
        <div className="cc-people__modalfoot">
          <button className="cc-btn" onClick={() => setFreshLink(null)}>Done</button>
        </div>
      </Modal>

      <Modal open={confirmRemove != null} onClose={() => setConfirmRemove(null)} title="Remove this person?">
        <p className="cc-people__modaltext">
          {confirmRemove?.email} will be signed out everywhere and will not be able to sign back in.
          Their tables and their runs stay exactly where they are. If you only want to stop them for
          now, Suspend does that and can be undone.
        </p>
        <div className="cc-people__modalfoot">
          <button className="cc-btn" onClick={() => setConfirmRemove(null)}>Cancel</button>
          <button
            className="cc-btn cc-btn--danger"
            disabled={busy}
            onClick={() => { const t = confirmRemove!; setConfirmRemove(null); void run(() => session.remove(t.id)); }}
          >
            Remove
          </button>
        </div>
      </Modal>

      <Modal open={confirmHandover != null} onClose={() => setConfirmHandover(null)} title="Hand over this instance?">
        <p className="cc-people__modaltext">
          {confirmHandover?.email} becomes the owner and you become an admin. Only the owner can hand
          it on again — so after this, only they can give it back.
        </p>
        <div className="cc-people__modalfoot">
          <button className="cc-btn" onClick={() => setConfirmHandover(null)}>Cancel</button>
          <button
            className="cc-btn cc-btn--primary"
            disabled={busy}
            onClick={() => {
              const t = confirmHandover!;
              setConfirmHandover(null);
              void run(() => session.setRole(t.id, "owner"), onSessionChanged);
            }}
          >
            Hand it over
          </button>
        </div>
      </Modal>
    </section>
  );
}
