// A JSON value, with its shape intact.
//
// The point is the hierarchy. A cell holding a research result is not a string — it is a `reason`,
// a `confidence`, an `hq` with a city and a country inside it, and a `steps taken` with four entries
// in it. Flattening that to `hq.city` beside `hq.country` throws away the one thing that tells you
// what you are looking at, and printing it as raw JSON asks the reader to parse braces.
//
// So: objects nest and expand, arrays announce how many items they hold, and every leaf carries the
// action that turns it into a column. The action lives on the row it belongs to, because "which
// field did I mean" is a question nobody should have to answer twice.

import { useState, type ReactNode } from "react";
import "./JsonTree.css";

export type NodeKind = "text" | "number" | "boolean" | "object" | "array" | "url" | "null";

export interface TreeNode {
  /**
   * True for anything living inside an array.
   *
   * These nodes are for READING. `contacts.0.email` as a column would mean something different on
   * every row, so the per-field actions are withheld here — but withholding the nodes themselves
   * was the bug: a cell holding a one-item list rendered as "Items [1]" with nothing under it,
   * which reads as "empty but says 1".
   */
  inArray?: boolean;
  /**
   * The synthetic "…N more items not shown" row. It is a sentence, not a field: its path ends in
   * `__more`, which no value has, so an action offered on it created a column that resolved to
   * undefined on every row. Nothing may act on it.
   */
  placeholder?: boolean;
  /** Dotted path from the root, which is exactly what the derive engine takes. */
  path: string;
  /** The key at this level, already humanised for display. */
  label: string;
  kind: NodeKind;
  /** Rendered for a leaf; a count for a container. */
  preview: string;
  children?: TreeNode[];
  /** Items, for an array. */
  count?: number;
  /** The raw value, so an action can inspect it without re-walking. */
  value: unknown;
}

/** Type glyphs, matching the column-type language used elsewhere in the app. */
const GLYPH: Record<NodeKind, string> = {
  text: "T",
  number: "#",
  boolean: "✓",
  url: "↗",
  null: "—",
  object: "{}",
  array: "[]",
};

function kindOf(v: unknown): NodeKind {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return "url";
  return "text";
}

function previewOf(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return `${v.length}`;
  if (typeof v === "object") return `${Object.keys(v as object).length}`;
  const s = String(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/** `total_input_tokens` and `totalInputTokens` both read as "Total input tokens". */
export function humanise(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** How many array items are shown before the rest are summarised in one honest line. */
const ARRAY_CAP = 30;

function childrenOf(v: unknown, path: string, depth: number, inArray: boolean): TreeNode[] | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return arrayItems(v, path, depth);
  if (v && typeof v === "object") return buildTree(v, path, depth, inArray);
  return undefined;
}

/**
 * The items of an array, as readable nodes.
 *
 * Everything under here is marked `inArray`, which is what withholds the make-a-column actions:
 * `contacts.0.email` as a column would mean something different on every row. But the items are
 * SHOWN — an array that renders as a count with nothing under it reads as broken, and the whole
 * reason someone opens a research result is to read what the steps actually said.
 */
export function arrayItems(list: unknown[], prefix: string, depth = 0): TreeNode[] {
  const out: TreeNode[] = list.slice(0, ARRAY_CAP).map((item, i) => {
    const path = prefix ? `${prefix}.${i}` : String(i);
    return {
      path,
      label: `Item ${i + 1}`,
      kind: kindOf(item),
      preview: previewOf(item),
      count: Array.isArray(item) ? item.length : undefined,
      children: childrenOf(item, path, depth + 1, true),
      value: item,
      inArray: true,
    };
  });
  // Said, not silently cut. A list that claims 200 and shows 30 with no note is a lie by omission.
  if (list.length > ARRAY_CAP) {
    out.push({
      path: `${prefix}.__more`,
      label: "…",
      kind: "null",
      preview: `${list.length - ARRAY_CAP} more items not shown`,
      value: null,
      inArray: true,
      placeholder: true,
    });
  }
  return out;
}

export function buildTree(value: unknown, prefix = "", depth = 0, inArray = false): TreeNode[] {
  if (depth > 6 || value == null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    const kind = kindOf(v);
    return {
      path,
      label: humanise(k),
      kind,
      preview: previewOf(v),
      count: Array.isArray(v) ? v.length : undefined,
      children: childrenOf(v, path, depth + 1, inArray),
      value: v,
      inArray: inArray || undefined,
    };
  });
}

/** Keep a node when it, or anything under it, matches. A parent that matches keeps its children. */
export function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return nodes;
  const out: TreeNode[] = [];
  for (const n of nodes) {
    const selfHit = n.label.toLowerCase().includes(needle) || n.preview.toLowerCase().includes(needle);
    const kids = n.children ? filterTree(n.children, needle) : [];
    if (selfHit) out.push(n);
    else if (kids.length > 0) out.push({ ...n, children: kids });
  }
  return out;
}

interface Props {
  nodes: TreeNode[];
  /** Forced open while a search is narrowing, so a match three levels down is visible. */
  expandAll?: boolean;
  /** The control shown on the right of a leaf row. */
  leafAction?: (node: TreeNode) => ReactNode;
  /**
   * What an OBJECT row offers. It offered nothing, and said nothing about why — which reads
   * identically whether the control was withheld on purpose or forgotten.
   */
  objectAction?: (node: TreeNode) => ReactNode;
  /** The control shown on the right of an array row. */
  listAction?: (node: TreeNode) => ReactNode;
  depth?: number;
}

export function JsonTree({ nodes, expandAll, leafAction, listAction, objectAction, depth = 0 }: Props) {
  return (
    <div className="cc-jt">
      {nodes.map((n) => (
        <TreeRow key={n.path} node={n} expandAll={expandAll} leafAction={leafAction} listAction={listAction} objectAction={objectAction} depth={depth} />
      ))}
    </div>
  );
}

interface RowProps {
  node: TreeNode;
  expandAll?: boolean;
  leafAction?: (node: TreeNode) => ReactNode;
  /**
   * What an OBJECT row offers. It offered nothing, and said nothing about why — which reads
   * identically whether the control was withheld on purpose or forgotten.
   */
  objectAction?: (node: TreeNode) => ReactNode;
  listAction?: (node: TreeNode) => ReactNode;
  depth: number;
}

function TreeRow({ node, expandAll, leafAction, listAction, objectAction, depth }: RowProps) {
  // Containers at the top level start open — a container whose contents are hidden is a container
  // nobody knew held anything, and for a bare-array cell the top level is ALL there is. Deeper ones
  // start shut so a big result stays scannable.
  const [open, setOpen] = useState((node.kind === "object" || node.kind === "array") && depth === 0);
  const expanded = expandAll || open;
  const container = node.kind === "object" || node.kind === "array";
  const hasKids = (node.children?.length ?? 0) > 0;

  return (
    <div className="cc-jt__node" style={{ ["--jt-depth" as string]: String(depth) }}>
      <div className={`cc-jt__row cc-jt__row--${node.kind}`}>
        {container && hasKids ? (
          <button
            className="cc-jt__caret"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.label}`}
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d={expanded ? "M3 6l5 5 5-5" : "M6 3l5 5-5 5"} />
            </svg>
          </button>
        ) : (
          <span className="cc-jt__caret cc-jt__caret--none" aria-hidden />
        )}

        <span className={`cc-jt__glyph cc-jt__glyph--${node.kind}`} aria-hidden>{GLYPH[node.kind]}</span>
        <span className="cc-jt__label truncate" title={node.path}>{node.label}</span>

        {node.kind === "array" ? (
          <span className="cc-jt__count mono">[{node.count}]</span>
        ) : node.kind === "object" ? (
          <span className="cc-jt__count mono">{"{"}{node.preview}{"}"}</span>
        ) : (
          <span className="cc-jt__value" title={String(node.value ?? "")}>{node.preview}</span>
        )}

        {/* Actions sit on the row they act on. A single "do something" control at the top of the
            panel would need the user to say which field they meant, having just pointed at it.

            The truncation row is exempt: it is prose, not a field. Its `__more` path survives
            starPath (only numeric segments become stars) and resolves to undefined everywhere, so
            an action there offered to build a permanently empty column. */}
        <span className="cc-jt__act">
          {node.placeholder ? null
            : node.kind === "array" ? listAction?.(node)
            : node.kind === "object" ? objectAction?.(node)
            : leafAction?.(node)}
        </span>
      </div>

      {expanded && hasKids && (
        <JsonTree nodes={node.children!} expandAll={expandAll} leafAction={leafAction} listAction={listAction} objectAction={objectAction} depth={depth + 1} />
      )}
    </div>
  );
}
