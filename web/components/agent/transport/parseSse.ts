// Summit Agent — the SSE `data:` line splitter.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §5.6 (the stream loop).
//
// PURE. No DOM, no streams, no timers, no React. Everything in here is a string → string
// transformation, which is what makes it the one piece of the transport that is trivially unit
// testable — and it is the piece most likely to break in a way that only shows up under real
// network chunking.
//
// ══ What it has to survive ══════════════════════════════════════════════════════════════════════
//
// Both Summit servers write `data: ${JSON.stringify(x)}\n\n`. A `ReadableStream` chunk boundary
// falls wherever TCP feels like it, so all of these happen in production:
//
//   chunk 1: 'data: {"t":"tok'          ← split mid-JSON, mid-key
//   chunk 2: 'en","text":"hi"}\n\ndata: {"t":"done"}\n\n'
//   chunk 1: 'data: {"t":"done"}\r\n'   ← some proxies normalise to CRLF
//   chunk 1: ': keepalive\n\n'          ← SSE comment, must be ignored not parsed
//
// The rule is simple: only ever emit COMPLETE lines. Anything after the last newline stays in the
// buffer until the next chunk completes it. Get this wrong and you get a JSON.parse error every
// few hundred tokens, which the old client silently swallowed with `catch { continue; }` — losing
// a token each time.
//
// ══ Why line-based and not full SSE frame semantics ═════════════════════════════════════════════
//
// The strict spec accumulates `data:` lines until a blank line dispatches the event. Summit's
// servers emit exactly one JSON object per `data:` line (JSON.stringify escapes newlines, so a
// payload can never contain a raw one) and always follow it with a blank line. Line-based
// splitting therefore produces identical results, and it degrades better: if a server ever omits
// the trailing blank line, frame-accumulation would buffer forever while this still delivers.

/** The prefix the servers write. Handles both `data:x` and `data: x`. */
const DATA_PREFIX = "data:";

export interface SseSplit {
  /** Leftover partial line, to be prepended to the next chunk. */
  buffer: string;
  /** Complete `data:` payloads found in this chunk, in order. Never partial. */
  payloads: string[];
}

/**
 * The pure core. Feed it the carry-over buffer and one decoded chunk.
 *
 * Non-`data:` lines (SSE comments starting `:`, `event:`, `id:`, `retry:`, blank separators) are
 * dropped — Summit's servers emit none of them today, and silently ignoring them is what the SSE
 * spec requires of a client that does not use them.
 */
export function splitSseChunk(buffer: string, chunk: string): SseSplit {
  const combined = buffer + chunk;
  const lines = combined.split("\n");

  // The last element is either "" (the chunk ended on a newline) or a partial line. Either way it
  // is not safe to emit, so it becomes the new buffer. This single line is the whole fix for the
  // split-mid-JSON case.
  const nextBuffer = lines.pop() ?? "";

  const payloads: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Strip a trailing CR so CRLF-normalising proxies do not leave `}\r` on the end of the JSON.
    const line = lines[i].charCodeAt(lines[i].length - 1) === 13 ? lines[i].slice(0, -1) : lines[i];
    if (line.length === 0) continue;
    if (line.charCodeAt(0) === 58 /* ':' */) continue; // SSE comment / keepalive
    if (!line.startsWith(DATA_PREFIX)) continue; // event:/id:/retry: — not used here
    // The spec strips exactly one leading space after the colon.
    let payload = line.slice(DATA_PREFIX.length);
    if (payload.charCodeAt(0) === 32) payload = payload.slice(1);
    if (payload.length === 0) continue;
    payloads.push(payload);
  }

  return { buffer: nextBuffer, payloads };
}

export interface SseParser {
  /** Feed a decoded chunk; get back the complete payloads it completed. */
  push(chunk: string): string[];
  /**
   * Flush at end of stream. Returns the buffered tail if — and only if — it is a complete-looking
   * `data:` line. A server that closes without a final newline is rare but legal.
   */
  flush(): string[];
  /** For tests/diagnostics: what is still held back. */
  readonly pending: string;
}

/** Stateful wrapper around `splitSseChunk`. One per stream. */
export function createSseParser(): SseParser {
  let buffer = "";
  return {
    push(chunk: string): string[] {
      const { buffer: next, payloads } = splitSseChunk(buffer, chunk);
      buffer = next;
      return payloads;
    },
    flush(): string[] {
      if (!buffer) return [];
      // Append a newline so the tail becomes a complete line, then run the same code path — no
      // second, subtly different parser to keep in sync.
      const { payloads } = splitSseChunk(buffer, "\n");
      buffer = "";
      return payloads;
    },
    get pending() {
      return buffer;
    },
  };
}

/**
 * JSON.parse that returns null instead of throwing.
 *
 * A malformed frame is a server bug, not a client crash. Kept here (rather than inline in the
 * reader loop) so the "what does a bad frame do" answer lives with the parser and stays testable.
 */
export function parseSsePayload(payload: string): unknown | null {
  try {
    return JSON.parse(payload);
  } catch {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[agent] dropped unparseable SSE payload:", payload.slice(0, 200));
    }
    return null;
  }
}
