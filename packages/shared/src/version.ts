/**
 * The release number inside whatever a harness says about its version.
 *
 * Every CLI phrases it differently — `claude --version` prints
 * `2.1.282 (Claude Code)`, codex-acp's handshake names its npm package
 * (`@agentclientprotocol/codex-acp 1.4.0`) — and a picker that shows the raw
 * string next to the harness name has no room left for the name. The number is
 * the only part worth showing: the name is already the harness label.
 */
export function versionNumber(raw: string | null | undefined): string | null {
  const text = raw?.trim()
  if (!text) return null
  return text.match(/(?<![\d.])\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]*[0-9A-Za-z])?/)?.[0] ?? text
}
