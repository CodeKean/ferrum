// The door.
//
// Three things happen on this screen and they are deliberately ONE component, because they are the
// same form with a different verb: claiming an unclaimed instance, accepting an invitation, and
// signing in. Splitting them would mean three copies of the password field, the error line, the
// pending state and the keyboard handling — and three places for one of those to drift.
//
// This screen is never seen on a single-user install. The app renders it only when the instance has
// been claimed and nobody is signed in, so the local case still opens straight onto the grid.

import { useEffect, useState, type FormEvent } from "react";
import { session, type Role, type SessionState } from "../api.ts";
import "./SignIn.css";

/** What the screen is for right now. */
type Mode = "signin" | "claim" | "invite";

const ROLE_WORDS: Record<Role, string> = {
  viewer: "You will be able to look at everything and change nothing.",
  member: "You will be able to build tables and run columns, which spends money.",
  admin: "You will be able to do all of that, plus manage the keys and the people here.",
  owner: "You will own this instance.",
};

interface Props {
  /** True on a first run: nobody has claimed this copy yet. */
  unclaimed: boolean;
  /** Reachable from other machines. Changes what is worth warning about, not what is possible. */
  shared: boolean;
  /** Who is already signed in, when somebody opens an invitation without signing out first. */
  signedInAs: string | null;
  onSignedIn: (state: SessionState) => void;
}

export function SignIn({ unclaimed, shared, signedInAs, onSignedIn }: Props) {
  // An invite link is /invite/<token>. Read once — the token is a credential, so it is taken out of
  // the address bar as soon as it has been read rather than left in the history.
  const [token] = useState<string | null>(() => {
    const m = /^\/invite\/(.+)$/.exec(window.location.pathname);
    return m ? decodeURIComponent(m[1]!) : null;
  });

  const mode: Mode = token ? "invite" : unclaimed ? "claim" : "signin";

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [invitedAs, setInvitedAs] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Null while an invite is still being checked, so the form does not flash a field the person will
  // not be allowed to fill in.
  const [checking, setChecking] = useState(mode === "invite");

  useEffect(() => {
    if (mode !== "invite" || !token) return;
    let live = true;
    session.peekInvite(token)
      .then((r) => { if (!live) return; setEmail(r.invite.email); setInvitedAs(r.invite.role); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [mode, token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const state =
        mode === "claim" ? await session.claim(email, password, name)
        : mode === "invite" ? await session.acceptInvite(token!, password, name)
        : await session.signIn(email, password);
      // The token is a credential. Off the address bar before the app renders, so it is not in the
      // history, not in a screenshot, and not in whatever the next page sends as a Referer.
      if (mode === "invite") window.history.replaceState({}, "", "/");
      onSignedIn(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const title =
    mode === "claim" ? "Set up Ferrum"
    : mode === "invite" ? "Join this workspace"
    : "Sign in";

  const cta = mode === "claim" ? "Create the first account" : mode === "invite" ? "Create my account" : "Sign in";

  return (
    <main className="cc-signin">
      <form className="cc-signin__card" onSubmit={submit}>
        <div className="cc-signin__mark" aria-hidden>
          <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3h10M3 8h7M3 13h4" />
          </svg>
        </div>
        <h1 className="cc-signin__title">{title}</h1>

        {mode === "claim" && (
          <p className="cc-signin__lede">
            This copy of Ferrum has nobody on it yet. The account you make now owns it — you will be
            able to invite everyone else, and from this moment on everyone signs in.
          </p>
        )}
        {mode === "invite" && invitedAs && (
          <p className="cc-signin__lede">
            You have been invited as {invitedAs === "admin" ? "an admin" : `a ${invitedAs}`}.{" "}
            {ROLE_WORDS[invitedAs]}
          </p>
        )}
        {/* Somebody already signed in, opening an invitation — usually the admin checking the link
            they just sent. Without this they were dropped into the app with the invitation neither
            accepted nor explained, which reads as a dead link. */}
        {mode === "invite" && signedInAs && (
          <p className="cc-signin__warn">
            You are signed in as {signedInAs}. Creating this account signs you out of that one on this
            browser — the invitation is for {email || "someone else"}.{" "}
            <button type="button" className="cc-signin__inline" onClick={() => { window.location.href = "/"; }}>
              Go back to Ferrum instead
            </button>
          </p>
        )}

        {checking ? (
          // A fixed-height placeholder rather than nothing, so the card does not resize under the
          // cursor the moment the check comes back.
          <div className="cc-signin__wait" aria-live="polite">Checking that invitation…</div>
        ) : (
          <>
            <label className="cc-signin__field">
              <span className="cc-signin__label">Email</span>
              <input
                className="cc-signin__input"
                type="email"
                autoComplete="username"
                required
                // On an invitation the address is what was invited. Letting it be edited would mean
                // the account created is not the account that was approved.
                readOnly={mode === "invite"}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus={mode !== "invite"}
              />
            </label>

            {mode !== "signin" && (
              <label className="cc-signin__field">
                <span className="cc-signin__label">Your name</span>
                <input
                  className="cc-signin__input"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="So other people know who did what"
                  autoFocus={mode === "invite"}
                />
              </label>
            )}

            <label className="cc-signin__field">
              <span className="cc-signin__label">Password</span>
              <input
                className="cc-signin__input"
                type="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {mode !== "signin" && (
                <span className="cc-signin__hint">
                  At least 10 characters. A few ordinary words you will remember beats a short
                  scrambled one — length is what survives a leak.
                </span>
              )}
            </label>

            {/* Held open whether or not there is an error, so the button does not jump when one
                appears. This is the moment someone is aiming at it. */}
            <p className="cc-signin__error" role="alert">{error ?? ""}</p>

            <button className="cc-signin__go" type="submit" disabled={busy}>
              {busy ? "Just a moment…" : cta}
            </button>
          </>
        )}

        {mode === "claim" && shared && (
          <p className="cc-signin__warn">
            This copy answers on the network, so anyone who can reach it right now has full access.
            Creating this account closes that. Put it behind HTTPS before you invite anybody — sign-ins
            travel in a cookie.
          </p>
        )}
      </form>
    </main>
  );
}
