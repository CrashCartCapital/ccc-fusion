/**
 * Shared single-line JSON decoding (usage-lane).
 *
 * Both the one-shot structured-result scanner ({@link extractJsonObjects} in
 * one-shot-session.ts) and the Codex exec-mode usage observer
 * (codex-exec-usage.ts) need to decide whether one line of a merged
 * stdout+stderr PTY stream is a standalone JSON object (or array — the two
 * historically shared the same permissive `typeof === "object"` check, kept
 * here unchanged). This is the one place that decision is made, so the two
 * scanners cannot drift on what counts as a decodable JSONL line.
 */
export function decodeJsonObjectLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
