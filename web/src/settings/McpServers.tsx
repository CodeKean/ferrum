// Connected apps: the MCP servers this workspace can call.
//
// The one screen in the app that registers something this computer will RUN. A stdio app is a
// command plus arguments, spawned by the engine, so the wording here is deliberately plain about
// that rather than hiding it behind the word "integration" — somebody pasting a command off a web
// page should be able to tell what they are agreeing to.
//
// No credential is ever typed here. An app that needs a key gets `{{secret:Name}}` in a header or an
// environment variable and the value is resolved when the call is built, so this screen holds
// references and never values. There is nothing on it worth masking, which is why — unlike the key
// screens — everything it stores is shown back in full.
//
// Test is not decoration. A tool list typed from memory is right until the day the app is updated,
// and the failure otherwise lands per row, mid-run, after paying; so the screen asks the app what it
// offers and shows the answer.

import { useEffect, useState } from "react";
import { Select, SAVING_REASON } from "../ui/Select.tsx";
import { IconPlus, IconTrash } from "../ui/Icon.tsx";
import type { McpServer, McpToolInfo } from "../prompt/mcpConfig.ts";
import "./Providers.css";

interface Draft {
  id?: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  allowPrivate: boolean;
}

const BLANK: Draft = { name: "", transport: "stdio", command: "", args: "", url: "", allowPrivate: false };

const toDraft = (s: McpServer): Draft => ({
  id: s.id,
  name: s.name,
  transport: s.transport,
  command: s.command ?? "",
  args: (s.args ?? []).join(" "),
  url: s.url ?? "",
  allowPrivate: s.allowPrivate === true,
});

export function McpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Keyed by server, so one app's result can never render under another's name. */
  const [checked, setChecked] = useState<Record<string, { ok: boolean; error?: string; tools: McpToolInfo[] }>>({});
  const [checking, setChecking] = useState<string | null>(null);

  const load = () =>
    fetch("/api/mcp/servers")
      .then((r) => r.json())
      .then((d) => setServers(d.servers ?? []))
      .catch(() => setServers([]))
      .finally(() => setLoaded(true));

  useEffect(() => { void load(); }, []);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { id: draft.id, name: draft.name, transport: draft.transport };
      if (draft.transport === "stdio") {
        body.command = draft.command.trim();
        // Split on whitespace, because each argument is passed separately. Nothing goes through a
        // command line, so supporting quotes here would be a lie about how it is actually run.
        body.args = draft.args.split(/\s+/).filter(Boolean);
      } else {
        body.url = draft.url.trim();
        body.allowPrivate = draft.allowPrivate;
      }
      const res = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setDraft(null);
      await load();
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: McpServer) => {
    setBusy(true);
    setError(null);
    try {
      // A refusal answers with a status and an `error`, and neither was read — so a removal the
      // engine declined redrew the same list with the app still on it, which reads as the button
      // being broken rather than as the server having said no.
      const res = await fetch(`/api/mcp/servers/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.error) {
        setError(String(body?.error ?? `Could not remove "${s.name}".`));
        return;
      }
      setChecked((c) => { const n = { ...c }; delete n[s.id]; return n; });
      await load();
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const check = async (s: McpServer) => {
    setChecking(s.id);
    try {
      const res = await fetch(`/api/mcp/servers/${encodeURIComponent(s.id)}/tools`, { method: "POST" }).then((r) => r.json());
      setChecked((c) => ({ ...c, [s.id]: { ok: !!res.ok, error: res.error, tools: res.tools ?? [] } }));
    } catch {
      setChecked((c) => ({ ...c, [s.id]: { ok: false, error: "Could not reach the engine.", tools: [] } }));
    } finally {
      setChecking(null);
    }
  };

  return (
    <div>
      <p className="cc-set__lede">
        Apps that can answer a column, or that a research agent can call while it works. An app
        running on this computer sends nothing anywhere. A remote one is charged by whoever runs it.
      </p>

      {!loaded ? (
        <ul className="cc-prov__list">
          {[0, 1].map((i) => <li key={i} className="cc-prov__row cc-prov__row--skel" aria-hidden="true" />)}
        </ul>
      ) : (
        <ul className="cc-prov__list">
          {servers.map((s) => {
            const c = checked[s.id];
            return (
              <li key={s.id} className="cc-prov__row cc-prov__row--on">
                <div className="cc-prov__main">
                  <div className="cc-prov__id">
                    <span className="cc-prov__name">{s.name}</span>
                    <span className="cc-prov__tag">
                      {s.transport === "stdio" ? "On this computer" : "Remote"}
                    </span>
                    {s.transport === "http" && s.allowPrivate && (
                      <span className="cc-prov__tag cc-prov__tag--warn">Local network allowed</span>
                    )}
                  </div>
                  <p className="cc-prov__note">
                    {s.transport === "stdio"
                      ? `${s.command}${s.args?.length ? " " + s.args.join(" ") : ""}`
                      : s.url}
                  </p>
                  {c && (
                    <p className="cc-prov__note">
                      {c.ok
                        ? c.tools.length
                          ? `${c.tools.length} tool${c.tools.length === 1 ? "" : "s"}: ${c.tools.map((t) => t.name).join(", ")}`
                          : "Working, but it offers no tools."
                        : `Not working — ${c.error}`}
                    </p>
                  )}
                </div>
                <div className="cc-prov__acts">
                  <button className="cc-btn" disabled={checking === s.id} onClick={() => void check(s)}>
                    {checking === s.id ? "Checking…" : "Test"}
                  </button>
                  <button className="cc-btn" disabled={busy} onClick={() => { setError(null); setDraft(toDraft(s)); }}>
                    Edit
                  </button>
                  <button className="cc-btn cc-btn--danger" disabled={busy} onClick={() => void remove(s)} aria-label={`Remove ${s.name}`}>
                    <IconTrash />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {loaded && servers.length === 0 && !draft && (
        <p className="cc-set__hint">No apps yet.</p>
      )}

      {/* The form below shows the error while it is open; a removal happens with no form on screen,
          so without this its refusal had nowhere to appear. */}
      {error && !draft && <p className="cc-set__err">{error}</p>}

      {draft ? (
        <div className="cc-prov__form">
          {error && <p className="cc-set__err">{error}</p>}

          <label className="cc-set__field">
            <span className="cc-set__label">Name</span>
            <input
              className="cc-input"
              value={draft.name}
              placeholder="My lookup app"
              autoFocus
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>

          <div className="cc-set__field">
            <span className="cc-set__label">Where it runs</span>
            <Select
              label="Where it runs"
              showLabel={false}
              value={draft.transport}
              disabled={busy}
              disabledReason={SAVING_REASON}
              onChange={(v) => setDraft({ ...draft, transport: v as "stdio" | "http" })}
              options={[
                { value: "stdio", label: "On this computer" },
                { value: "http", label: "Somewhere else, over the web" },
              ]}
            />
          </div>

          {draft.transport === "stdio" ? (
            <>
              <label className="cc-set__field">
                <span className="cc-set__label">Command</span>
                <input
                  className="cc-input"
                  value={draft.command}
                  placeholder="npx"
                  spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                />
                <span className="cc-set__hint">
                  The program to start. Ferrum runs this on your computer, so only add one you trust.
                  It is started directly rather than through a command line, so characters like ; and
                  | are refused.
                </span>
              </label>
              <label className="cc-set__field">
                <span className="cc-set__label">Arguments</span>
                <input
                  className="cc-input"
                  value={draft.args}
                  placeholder="-y @modelcontextprotocol/server-filesystem ."
                  spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                />
                <span className="cc-set__hint">Separated by spaces.</span>
              </label>
            </>
          ) : (
            <>
              <label className="cc-set__field">
                <span className="cc-set__label">Web address</span>
                <input
                  className="cc-input"
                  value={draft.url}
                  placeholder="https://example.com/mcp"
                  spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                />
              </label>
              <label className="cc-set__check">
                <input
                  type="checkbox"
                  checked={draft.allowPrivate}
                  onChange={(e) => setDraft({ ...draft, allowPrivate: e.target.checked })}
                />
                <span className="cc-set__label">Allow addresses on this network</span>
              </label>
              <span className="cc-set__hint">
                Off unless you turn it on. It lets this app reach machines on your own network rather
                than only the public internet, so turn it on only for a server you run yourself.
              </span>
            </>
          )}

          <div className="cc-prov__formacts">
            <button className="cc-btn cc-btn--primary" disabled={busy} onClick={() => void save()}>Save</button>
            <button className="cc-btn" disabled={busy} onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="cc-btn" onClick={() => { setError(null); setDraft({ ...BLANK }); }}>
          <IconPlus /> App
        </button>
      )}
    </div>
  );
}
