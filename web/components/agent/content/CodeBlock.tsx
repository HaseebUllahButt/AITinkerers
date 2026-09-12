"use client";

// Fenced code inside an agent answer.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.3 / §7.9 checklist / P1.9 — header with a language label, a copy
// button whose string comes from the PARSE TREE (never `innerText`, which would pick up the cursor
// dot and any zero-width sentinel), unknown languages coerced to `text` rather than throwing, and
// highlighting that runs ONCE, after the stream settles.
//
// Why no highlight.js / shiki / prism: two reasons, both from §16's do-not-copy list. Highlighting
// on every token is a perf sink AND a DOM-ownership fight with React (Chainlit papers over it with a
// `data-highlighted` guard). And every off-the-shelf theme ships as a global, theme-blind stylesheet
// — `import 'highlight.js/styles/monokai-sublime.css'` makes code blocks dark in light mode. The
// tokenizer below is ~60 lines, colours itself from Summit's own tokens (so it is correct in both
// themes automatically), and adds no dependency.

import { Check, Copy } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { COPY_RESET_MS } from "../constants";
import { StreamCursor } from "./StreamCursor";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────── the tokenizer

type TokenKind = "comment" | "string" | "number" | "keyword" | "plain";

interface Token {
  kind: TokenKind;
  text: string;
}

interface Grammar {
  /** Groups, in order: 1 comment · 2 string · 3 number · 4 identifier. */
  re: RegExp;
  keywords: ReadonlySet<string>;
  /** SQL is written in either case; JS is not. */
  foldCase?: boolean;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/));

// C-family: // and /* */ comments, single/double/backtick strings, 0x/0b/exponent numbers.
const C_LIKE =
  /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|(\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b)|([A-Za-z_$][\w$]*)/g;

// Hash-family: # comments, plus Python's triple-quoted strings before the single-quoted forms.
const HASH_LIKE =
  /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|(\b\d[\d_]*(?:\.\d[\d_]*)?\b)|([A-Za-z_][\w]*)/g;

// SQL: -- and /* */ comments, '' as the escape inside a literal.
const SQL_LIKE =
  /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*'|"(?:""|[^"])*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)/g;

const JS_KEYWORDS = words(`
  as async await break case catch class const continue debugger declare default delete do else enum
  export extends false finally for from function get if implements import in instanceof interface let
  new null of private protected public readonly return satisfies set static super switch this throw
  true try type typeof undefined var void while yield
`);

const PY_KEYWORDS = words(`
  and as assert async await break class continue def del elif else except False finally for from
  global if import in is lambda None nonlocal not or pass raise return True try while with yield
`);

const SH_KEYWORDS = words(`
  case do done elif else esac export fi for function if in local return set source then unset until
  while
`);

const SQL_KEYWORDS = words(`
  all alter and as asc between by case create cross delete desc distinct drop else end exists from
  full group having in index inner insert into is join left like limit not null offset on or order
  outer right select set table then union update values view when where with
`);

const GRAMMARS: Readonly<Record<string, Grammar>> = {
  javascript: { re: C_LIKE, keywords: JS_KEYWORDS },
  typescript: { re: C_LIKE, keywords: JS_KEYWORDS },
  json: { re: C_LIKE, keywords: words("true false null") },
  css: { re: C_LIKE, keywords: words("important from to") },
  python: { re: HASH_LIKE, keywords: PY_KEYWORDS },
  bash: { re: HASH_LIKE, keywords: SH_KEYWORDS },
  yaml: { re: HASH_LIKE, keywords: words("true false null yes no") },
  sql: { re: SQL_LIKE, keywords: SQL_KEYWORDS, foldCase: true },
};

const ALIASES: Readonly<Record<string, string>> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  postgres: "sql",
  psql: "sql",
  scss: "css",
};

/**
 * Normalise a fence's language tag. Anything we cannot tokenize coerces to `text` — a fence tagged
 * `mermaid` or `Dockerfile` must render as plain code, never throw and never blank the answer.
 */
export function resolveLang(raw?: string): string {
  const key = (raw ?? "").trim().toLowerCase();
  if (!key) return "text";
  const canonical = ALIASES[key] ?? key;
  return canonical in GRAMMARS ? canonical : "text";
}

/**
 * Split source into coloured tokens. Pure and synchronous — it only ever runs on settled code (see
 * the `streaming` gate below), so it is off the token-arrival path entirely.
 */
export function tokenize(code: string, lang: string): Token[] {
  const grammar = GRAMMARS[lang];
  if (!grammar) return [{ kind: "plain", text: code }];

  const { re, keywords, foldCase } = grammar;
  // Module-level regexes are shared between call sites; a stale `lastIndex` from a previous run
  // would drop the head of this one.
  re.lastIndex = 0;

  const out: Token[] = [];
  const push = (kind: TokenKind, text: string) => {
    if (!text) return;
    // Coalesce runs of plain text so a 500-line file is a handful of DOM nodes, not one span per
    // identifier — the whole reason to highlight only once is to keep this cheap.
    const last = out[out.length - 1];
    if (kind === "plain" && last?.kind === "plain") last.text += text;
    else out.push({ kind, text });
  };

  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > cursor) push("plain", code.slice(cursor, m.index));
    if (m[1] !== undefined) push("comment", m[1]);
    else if (m[2] !== undefined) push("string", m[2]);
    else if (m[3] !== undefined) push("number", m[3]);
    else if (m[4] !== undefined) {
      const word = foldCase ? m[4].toLowerCase() : m[4];
      push(keywords.has(word) ? "keyword" : "plain", m[4]);
    }
    cursor = re.lastIndex;
  }
  if (cursor < code.length) push("plain", code.slice(cursor));
  return out;
}

// Colours come from Summit's own tokens, which are defined for both themes in globals.css. No
// hardcoded hex, no imported theme stylesheet.
const TOKEN_CLASS: Readonly<Record<TokenKind, string>> = {
  comment: "text-muted-foreground italic",
  string: "text-success",
  number: "text-chart-5",
  keyword: "text-primary",
  plain: "",
};

// ─────────────────────────────────────────────────────────────── the component

export interface CodeBlockProps {
  /** The exact source from the markdown parse tree. This is also what the copy button copies. */
  code: string;
  /** The fence's language tag, as written. Unknown values coerce to `text`. */
  lang?: string;
  /**
   * True while this fence is still receiving tokens (the cursor sentinel is inside it). Suppresses
   * highlighting and renders the pulsing dot at the end of the code.
   */
  streaming?: boolean;
  className?: string;
}

function CodeBlockInner({ code, lang, streaming = false, className }: CodeBlockProps) {
  const language = resolveLang(lang);

  // The gate. While the fence is open the source grows on every token, so highlighting here would
  // re-tokenize the whole block ~30 times a second and thrash the DOM React owns. Once the fence
  // closes, `streaming` flips false, this recomputes once, and the memo below keeps it that way.
  const tokens = useMemo(
    () => (streaming ? null : tokenize(code, language)),
    [streaming, code, language],
  );

  return (
    <div
      className={cn(
        "my-4 overflow-hidden rounded-lg border border-border bg-muted",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1">
        <span className="font-mono text-xs text-muted-foreground">{language}</span>
        <CopyCodeButton code={code} />
      </div>
      <pre
        // Focusable so a keyboard user can scroll a wide block horizontally, with a name that says
        // what they have landed on. `group` (not `region`) on purpose: a long answer with eight
        // snippets must not add eight landmarks to the screen-reader rotor.
        tabIndex={0}
        role="group"
        aria-label={`${language} code block`}
        className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-6"
      >
        <code>
          {tokens
            ? tokens.map((tok, i) =>
                tok.kind === "plain"
                  ? tok.text
                  : (
                      <span key={i} className={TOKEN_CLASS[tok.kind]}>
                        {tok.text}
                      </span>
                    ),
              )
            : code}
          {/* Inside the <code>, so the dot sits at the end of the last line and moves with it. */}
          {streaming && <StreamCursor />}
        </code>
      </pre>
    </div>
  );
}

/**
 * Memo'd on primitives. While a fence is open its `code` changes every token and this re-renders by
 * design (plain text, no tokenizer); every settled fence above it holds its highlighted output.
 */
export const CodeBlock = memo(CodeBlockInner);

// ─────────────────────────────────────────────────────────────── copy

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chainlit leaks this timeout: it fires setState after unmount, and a rapid re-click leaves the
  // ORIGINAL timer running so the confirmed state clears early. Clearing on unmount and before
  // every re-arm fixes both.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = useCallback(async () => {
    // `code` is the parse-tree string, so the copy never contains the zero-width cursor sentinel or
    // any of the highlight spans — which is exactly what an `innerText` read would give you.
    const ok = await writeClipboard(code);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPY_RESET_MS);
  }, [code]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={() => void onCopy()}
      aria-label={copied ? "Code copied" : "Copy code"}
      title={copied ? "Copied" : "Copy code"}
      className="text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  );
}

/**
 * Write plain text to the clipboard, with a fallback for insecure contexts.
 *
 * `navigator.clipboard` is undefined over plain http (a LAN dev host, a preview tunnel), and
 * touching it unguarded throws before any fallback can run. Returns false when the write failed, so
 * the button does not lie with a checkmark.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Off-screen rather than display:none — a hidden element cannot be selected.
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default CodeBlock;
