// The call an MCP column makes: which connected app, which of its tools, and what goes into it.
//
// The twin of HttpSettings, and it follows the same rules — everything saves itself rather than
// sitting behind a Save button, and the local/latest/mine refs exist for the reasons that file
// spells out at length.
//
// ── Why the tool list is fetched rather than typed ───────────────────────────────────────────────
// A tool's name and its argument names are the SERVER's, and they change when the app is updated. A
// list typed from memory is right until the day it silently is not, and the failure lands per row,
// mid-run, after paying. So the app is asked what it offers, and picking a tool pre-fills its
// arguments from the schema it published — the form starts from what the tool actually takes.

import { useCallback, useEffect, useRef, useState } from "react";
import { Select, SAVING_REASON } from "../ui/Select.tsx";
import { useAutosave } from "../ui/useAutosave.ts";
import { Section } from "../ui/Section.tsx";
import { RefField } from "./RefField.tsx";
import type { RefOption } from "./RefMenu.tsx";
import { IconPlus } from "../ui/Icon.tsx";
import type { Column } from "../api.ts";
import "./HttpSettings.css";

export type { Pair, McpCost, McpConfig, McpServer, McpToolInfo } from "./mcpConfig.ts";
export { DEFAULT_MCP } from "./mcpConfig.ts";
import type { Pair, McpCost, McpConfig, McpServer, McpToolInfo } from "./mcpConfig.ts";
import { DEFAULT_MCP, argsFromSchema, perCallUsd, money } from "./mcpConfig.ts";

const EMPTY_COST: McpCost = { unit: "", perCall: 0, packUnits: 0, packUsd: 0 };

function NumField(
  { value, onChange, placeholder, disabled }:
  { value: number; onChange: (n: number) => void; placeholder?: string; disabled?: boolean },
) {
  return (
    <input
      className="cc-input cc-input--num"
      type="number"
      min={0}
      step="any"
      value={value || ""}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(Number.isFinite(n) && n > 0 ? n : 0);
      }}
    />
  );
}

interface Props {
  column: Column;
  columns: Column[];
  refOptions: RefOption[];
  value: McpConfig;
  onChange: (next: McpConfig) => void;
  error?: string | null;
  busy?: boolean;
}

export function McpSettings({ column, columns, refOptions, value, onChange, error, busy }: Props) {
  const [local, setLocal] = useState(value);
  const mine = useRef(JSON.stringify(value));
  const latest = useRef(local);

  const [servers, setServers] = useState<McpServer[]>([]);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [loadingTools, setLoadingTools] = useState(false);

  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming === mine.current) return;
    mine.current = incoming;
    latest.current = value;
    setLocal(value);
  }, [value]);

  const autosave = useAutosave<McpConfig>(
    useCallback((next: McpConfig) => { mine.current = JSON.stringify(next); onChange(next); }, [onChange]),
  );

  const apply = (patch: Partial<McpConfig>): McpConfig => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setLocal(next);
    return next;
  };
  const edit = (patch: Partial<McpConfig>) => autosave.schedule(apply(patch));
  const set = (patch: Partial<McpConfig>) => {
    const next = apply(patch);
    autosave.markSaved(next);
    mine.current = JSON.stringify(next);
    onChange(next);
  };
  const commit = autosave.flush;

  // The registered apps. Read-only here — they are added in Settings, because a stdio app is a
  // command this machine runs and that is not a decision to make from inside a column.
  useEffect(() => {
    let alive = true;
    void fetch("/api/mcp/servers")
      .then((r) => r.json())
      .then((d) => { if (alive) setServers(d.servers ?? []); })
      .catch(() => { if (alive) setServers([]); });
    return () => { alive = false; };
  }, []);

  // What the chosen app can do, asked of the app itself.
  useEffect(() => {
    if (!local.serverId) { setTools([]); setToolsError(null); return; }
    let alive = true;
    setLoadingTools(true);
    setToolsError(null);
    void fetch(`/api/mcp/servers/${encodeURIComponent(local.serverId)}/tools`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setTools(d.tools ?? []);
        setToolsError(d.ok ? null : (d.error ?? "That app did not answer."));
      })
      .catch(() => { if (alive) setToolsError("Could not reach the engine."); })
      .finally(() => { if (alive) setLoadingTools(false); });
    return () => { alive = false; };
  }, [local.serverId]);

  const rowKeys = useRef<number[]>([]);
  const nextRowKey = useRef(1);
  const keysFor = (n: number): number[] => {
    while (rowKeys.current.length < n) rowKeys.current.push(nextRowKey.current++);
    if (rowKeys.current.length > n) rowKeys.current.length = n;
    return rowKeys.current;
  };

  const chosen = tools.find((t) => t.name === local.tool);
  const keys = keysFor(local.args.length);

  /** Picking a tool pre-fills its arguments, keeping any value already typed for a matching name. */
  const pickTool = (name: string) => {
    const info = tools.find((t) => t.name === name);
    const declared = argsFromSchema(info?.inputSchema);
    const existing = new Map(local.args.map((a) => [a.name, a.value]));
    rowKeys.current = [];
    set({
      tool: name,
      args: declared.length
        ? declared.map((d) => ({ name: d.name, value: existing.get(d.name) ?? "" }))
        : local.args,
    });
  };

  const cost = local.cost ?? EMPTY_COST;
  const setCost = (patch: Partial<McpCost>) => set({ cost: { ...cost, ...patch } });
  const each = perCallUsd(cost);

  return (
    <div className="cc-http">
      {error && <p className="cc-http__error">{error}</p>}

      <div className="cc-field">
        <span className="cc-field__label">Connected app</span>
        <Select
          label="Connected app"
          showLabel={false}
          value={local.serverId}
          disabled={busy}
          disabledReason={SAVING_REASON}
          onChange={(v) => set({ serverId: v, tool: "", args: [] })}
          options={[
            { value: "", label: servers.length ? "Choose an app…" : "No apps set up yet" },
            ...servers.map((s) => ({
              value: s.id,
              label: `${s.name}${s.transport === "stdio" ? " · on this computer" : " · remote"}`,
            })),
          ]}
        />
        <span className="cc-field__hint">
          Apps are added in Settings → Connected apps. An app that runs on this computer sends nothing
          anywhere.
        </span>
      </div>

      <div className="cc-field">
        <span className="cc-field__label">Tool</span>
        <Select
          label="Tool"
          showLabel={false}
          value={local.tool}
          disabled={busy}
          disabledReason={SAVING_REASON}
          onChange={pickTool}
          options={[
            {
              value: "",
              label: !local.serverId
                ? "Choose an app first"
                : loadingTools
                ? "Asking the app…"
                : tools.length
                ? "Choose a tool…"
                : "This app offered no tools",
            },
            ...tools.map((t) => ({ value: t.name, label: t.name })),
          ]}
        />
        {toolsError && <span className="cc-field__hint cc-http__error">{toolsError}</span>}
        {chosen?.description && <span className="cc-field__hint">{chosen.description}</span>}
      </div>

      <Section
        label="What to send"
        summary={local.args.length ? `${local.args.length} argument${local.args.length === 1 ? "" : "s"}` : "none"}
        defaultOpen={local.args.length > 0}
      >
        <p className="cc-http__costnote">
          The tool's own inputs. Type / in a value to put one of this row's columns in.
        </p>
        {local.args.map((p, i) => (
          <div className="cc-http__pair" key={keys[i]}>
            <input
              className="cc-input cc-http__pname"
              value={p.name}
              placeholder="argument"
              aria-label="Argument name"
              spellCheck={false}
              onChange={(e) => edit({ args: local.args.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
              onBlur={commit}
            />
            <RefField
              className="cc-input cc-http__pval"
              value={p.value}
              placeholder="value, or / for a column"
              ariaLabel="Argument value"
              columns={columns}
              options={refOptions}
              onChange={(v) => edit({ args: local.args.map((x, j) => (j === i ? { ...x, value: v } : x)) })}
              onBlur={commit}
            />
            <button
              className="hk-icon-btn"
              onClick={() => {
                rowKeys.current.splice(i, 1);
                set({ args: local.args.filter((_, j) => j !== i) });
              }}
              aria-label="Remove this argument"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        ))}
        <button className="cc-http__add" disabled={busy} onClick={() => set({ args: [...local.args, { name: "", value: "" }] })}>
          <IconPlus /> Add argument
        </button>
      </Section>

      <div className="cc-field">
        <span className="cc-field__label">What to keep from the answer</span>
        <input
          className="cc-input"
          value={local.responsePath}
          placeholder="industry"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => edit({ responsePath: e.target.value })}
          onBlur={commit}
        />
        <span className="cc-field__hint">
          A field from the tool's answer, like <code>industry</code> or <code>company.size</code>.
          Leave it blank to keep the whole answer.
        </span>
      </div>

      <Section label="When it goes wrong" summary={`${Math.round(local.timeoutMs / 1000)}s`} defaultOpen={false}>
        <label className="cc-field cc-field--tight">
          <span className="cc-field__label">Give up after</span>
          <div className="cc-http__inline">
            <NumField
              value={Math.round(local.timeoutMs / 1000)}
              disabled={busy}
              placeholder="30"
              onChange={(n) => set({ timeoutMs: Math.max(1, n) * 1000 })}
            />
            <span className="cc-http__unit">seconds</span>
          </div>
        </label>
        <p className="cc-http__costnote">
          Per row, so it multiplies. Thirty seconds across a thousand rows is a run you can sit
          through; two minutes is not.
        </p>
      </Section>

      <Section
        label="What this costs"
        summary={
          cost.perCall > 0
            ? [
                `${cost.perCall} ${cost.unit.trim() || "unit"}${cost.perCall === 1 ? "" : "s"} a call`,
                each > 0 ? `${money(each)} each` : null,
              ].filter(Boolean).join(" · ")
            : "not set"
        }
        defaultOpen={cost.perCall > 0}
      >
        <p className="cc-http__costnote">
          Optional, and it changes nothing about the call — it is only how the workspace prices it.
          Without it a table calling a paid app reports $0, which reads as free. An app on your own
          computer usually costs nothing, so leave this alone.
        </p>
        <div className="cc-http__cost">
          <div className="cc-field cc-field--tight">
            <span className="cc-field__label">One call uses</span>
            <div className="cc-http__inline">
              <NumField value={cost.perCall} disabled={busy} placeholder="1" onChange={(n) => setCost({ perCall: n })} />
              <input
                className="cc-input cc-input--unit"
                type="text"
                value={cost.unit}
                placeholder="credits"
                disabled={busy}
                onChange={(e) => setCost({ unit: e.target.value })}
                onBlur={commit}
              />
            </div>
          </div>
          <div className="cc-field cc-field--tight">
            <span className="cc-field__label">You buy</span>
            <div className="cc-http__inline">
              <NumField value={cost.packUnits} disabled={busy} placeholder="1000" onChange={(n) => setCost({ packUnits: n })} />
              <span className="cc-http__unit">for</span>
              <NumField value={cost.packUsd} disabled={busy} placeholder="49" onChange={(n) => setCost({ packUsd: n })} />
              <span className="cc-http__unit">dollars</span>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}
