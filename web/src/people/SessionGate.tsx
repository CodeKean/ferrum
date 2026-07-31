// The door, and what is behind it.
//
// Wraps the whole app rather than threading a prop through it: any screen that needs to know what
// the person may do calls `useSession()`, and no component in between has to carry something it does
// not use. On a single-user install this resolves once to "claimed: false, everything allowed" and
// is then invisible — the app renders exactly as it did before teams existed.
//
// It also owns the one refresh that matters: when someone's role changes, or they sign out in
// another tab, the app has to find out. `reload()` is handed down for the first case; a 401 from any
// request handles the second, because the fetch wrapper reports it here.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { session, type SessionState } from "../api.ts";
import { SignIn } from "./SignIn.tsx";

interface Ctx {
  me: SessionState;
  /** Re-read who you are and what you may do. Call after anything that could change either. */
  reload: () => void;
}

/**
 * The value before the first fetch lands.
 *
 * Everything allowed, deliberately: this is only ever read for the fraction of a second before the
 * real answer arrives, and it is used to decide whether to DRAW a control, never whether to permit
 * an action — the server decides that. Starting from "nothing allowed" would flash a disabled
 * toolbar on every load of the single-user app, which is the common case.
 */
const OPTIMISTIC: SessionState = {
  claimed: false,
  shared: false,
  person: null,
  can: { write: true, spend: true, settings: true, people: true, own: true },
};

/** The one path that is about an invitation rather than about the app. Matches SignIn. */
const INVITE_PATH = /^\/invite\/.+/;

const SessionContext = createContext<Ctx>({ me: OPTIMISTIC, reload: () => {} });

export const useSession = (): Ctx => useContext(SessionContext);

export function SessionGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<SessionState | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(() => {
    session.who()
      .then((s) => { setMe(s); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  /**
   * Someone signing out in another tab, or a session ending while this one sat idle.
   *
   * Re-checked when the tab is brought back to the front rather than on a timer: a poll would be a
   * request every N seconds forever to catch something that happens roughly never, and the moment
   * the answer actually matters is the moment somebody looks at the screen again.
   */
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [reload]);

  // Nothing at all until the first answer. A splash here would be a flash on every load of the
  // local app, and the request is a single indexed lookup against a local database.
  if (!me) {
    return failed ? (
      <main className="cc-signin">
        <div className="cc-signin__card">
          <h1 className="cc-signin__title">Ferrum is not answering</h1>
          <p className="cc-signin__lede">
            The engine is not running, or this page cannot reach it. Start it and reload.
          </p>
        </div>
      </main>
    ) : null;
  }

  /**
   * An invitation is answered even when somebody is already signed in.
   *
   * Reproduced: an admin opening the link they had just copied — to check it — was dropped straight
   * into the app, with the invitation neither accepted nor explained. It looked like a dead link. So
   * the invite path always renders the invite screen, which then says who is currently signed in and
   * that accepting means signing out of that account.
   */
  if (INVITE_PATH.test(window.location.pathname)) {
    return <SignIn unclaimed={!me.claimed} shared={me.shared} signedInAs={me.person?.email ?? null} onSignedIn={setMe} />;
  }

  if (me.claimed && !me.person) {
    return <SignIn unclaimed={false} shared={me.shared} signedInAs={null} onSignedIn={setMe} />;
  }

  /**
   * An unclaimed instance on a PUBLIC address is open to whoever reaches it first.
   *
   * So the setup screen is forced rather than offered — the app is not usable until somebody claims
   * it, because "usable" here means "usable by anyone on the network". On loopback there is nothing
   * to protect against and no screen appears at all, which is the whole single-user case.
   */
  if (!me.claimed && me.shared) {
    return <SignIn unclaimed shared signedInAs={null} onSignedIn={setMe} />;
  }

  return <SessionContext.Provider value={{ me, reload }}>{children}</SessionContext.Provider>;
}
