/**
 * Newline-delimited protocol lines out of a byte stream.
 *
 * Every harness here speaks one JSON message per line — Claude's `stream-json`,
 * Command Code's NDJSON, ACP's JSON-RPC, the transcript JSONL — and a read can
 * end anywhere: mid-line, mid-character, or after thousands of lines at once.
 *
 * Two things this does that a plain `buffer += chunk; buffer.split('\n')` did
 * not. A chunk without a newline is only appended, never rescanned, so a single
 * multi-megabyte line (a pasted image echoed back, a long tool result, a
 * `session/load` replay) costs its length once rather than once per chunk. And
 * it counts the bytes still waiting after the last newline, which is what lets a
 * caller persist an offset that sits on a line boundary: an offset saved in the
 * middle of a line is a restart that resumes on half a JSON message, fails to
 * parse it and silently drops it — and a dropped `result` is a turn that never
 * ends.
 *
 * `0x0a` never occurs inside a multi-byte UTF-8 sequence, so counting newlines
 * on the raw bytes agrees with the decoded text.
 */
export class LineSplitter {
  private decoder = new TextDecoder('utf-8')
  private rest = ''
  /** Bytes received after the last newline: what a restart has to read again. */
  pendingBytes = 0

  /** The complete lines this chunk finishes, untrimmed and possibly empty. */
  push(bytes: Uint8Array): string[] {
    const text = this.decoder.decode(bytes, { stream: true })
    const last = bytes.lastIndexOf(0x0a)
    if (last < 0) {
      this.pendingBytes += bytes.byteLength
      this.rest += text
      return []
    }
    this.pendingBytes = bytes.byteLength - last - 1
    const lines = (this.rest + text).split('\n')
    this.rest = lines.pop() ?? ''
    return lines
  }

  /** What is left once the stream has ended: a last line with no newline after it. */
  flush(): string {
    const rest = this.rest + this.decoder.decode()
    this.rest = ''
    this.pendingBytes = 0
    return rest
  }
}
