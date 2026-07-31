// Who can reach one workbook.
//
// Off by default, and that default is the design: a team sharing one workspace is the common case,
// and making everybody request access to everything is how a tool stops being opened. Restricting a
// workbook is the exception you turn on for the one that holds something sensitive.
//
// Only ever shown on a claimed instance — there is nobody to share with otherwise.

import { useCallback, useEffect, useState } from "react";
import { session, type Person } from "../api.ts";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import "./ShareWorkbook.css";

const ACCESS_OPTIONS = [
  { value: "view", label: "Can look" },
  { value: "edit", label: "Can change" },
  { value: "none", label: "No access" },
];

interface Props {
  workbookId: string;
  workbookName: string;
  /** The person doing the sharing, so their own row can say so rather than offering to remove them. */
  myId: number | null;
  onClose: () => void;
}

export function ShareWorkbook({ workbookId, workbookName, myId, onClose }: Props) {
  const [restricted, setRestricted] = useState(false);
  const [grants, setGrants] = useState<Record<number, "view" | "edit">>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await session.access(workbookId);
      setRestricted(r.restricted);
      setGrants(Object.fromEntries(r.grants.map((g) => [g.userId, g.access])));
      setPeople(r.people);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [workbookId]);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Who can open "${workbookName}"`}>
      <div className="cc-share">
        <label className="cc-share__toggle">
          <input
            type="checkbox"
            checked={restricted}
            disabled={busy || !loaded}
            onChange={(e) => void run(() => session.setRestricted(workbookId, e.target.checked))}
          />
          <span>
            <strong className="cc-share__togglelabel">Only certain people</strong>
            <span className="cc-share__hint">
              {restricted
                ? "Only the people listed below can open this. To everyone else it is not there at all."
                : "Everyone here can open this, which is how a shared workspace normally works. Turn this on for the one workbook that holds something sensitive."}
            </span>
          </span>
        </label>

        <p className="cc-share__error" role="alert">{error ?? ""}</p>

        {restricted && (
          <>
            {people.length === 0 ? (
              <p className="cc-share__hint">
                Only an admin can see the full list of people here, so you cannot add anyone from
                this screen. You can still open it yourself — ask an admin to share it with the rest.
              </p>
            ) : (
              <ul className="cc-share__list">
                {people.map((p) => {
                  const mine = p.id === myId;
                  const admin = p.role === "admin" || p.role === "owner";
                  return (
                    <li key={p.id} className="cc-share__row">
                      <span className="cc-share__who truncate">
                        {p.name || p.email}
                        {mine && <span className="cc-share__you">you</span>}
                      </span>
                      {admin ? (
                        // Said plainly rather than shown as a dropdown that would not change
                        // anything. An admin can already read the database and rotate the keys, so a
                        // restriction that pretended to hide it from them would be a fiction — and a
                        // fiction in a permission screen is worse than an honest permission.
                        <span className="cc-share__fixed">Admins always can</span>
                      ) : (
                        <Select
                          label="Access"
                          size="sm"
                          value={grants[p.id] ?? "none"}
                          options={ACCESS_OPTIONS}
                          onChange={(v) => void run(() =>
                            session.setGrant(workbookId, p.id, v === "none" ? null : (v as "view" | "edit")),
                          )}
                          aria-label={`What ${p.email} can do with this workbook`}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        <div className="cc-share__foot">
          <button className="cc-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}
