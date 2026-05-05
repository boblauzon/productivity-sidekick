// ─── Sanitization utilities ────────────────────────────────────────────────────
// Centralized sanitization for any user-supplied string that will be rendered
// or used to navigate. Every code path that accepts a URL from a person MUST
// route through `sanitizeUrl` — anything else is a XSS vector.
//
// Threat model:
//   • `javascript:` URLs in <a href> or window.open execute arbitrary script
//   • `data:` URLs can deliver HTML/JS payloads
//   • `vbscript:`, `file:`, `blob:` (when crafted) are similar risks
//   • Mixed-case scheme tricks (e.g. `JaVaScRiPt:`) bypass naïve string.startsWith
//   • Leading whitespace / control chars (e.g. "\t\njavascript:...") bypass naïve checks
//
// Strategy:
//   • Strip leading whitespace + ASCII control chars before parsing
//   • Use the URL constructor for canonicalization (case-folds the scheme)
//   • Allow-list `http:` and `https:` only — deny everything else, including
//     protocol-relative URLs that resolve to the parent's scheme
//   • Return `null` on rejection so callers fail safe

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Returns a canonicalized, safe URL string, or `null` if the input is rejected.
 * Never throws. Callers must handle `null` (typically: refuse to render the link).
 */
export function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  // Strip leading whitespace and ASCII control characters that browsers
  // historically tolerated when parsing href values.
  const cleaned = raw.replace(/^[\s\u0000-\u001f]+/, '').trim();
  if (!cleaned) return null;

  // Reject protocol-relative URLs outright — they inherit the page's scheme,
  // which is not an explicit choice by the caller.
  if (cleaned.startsWith('//')) return null;

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    // Not absolute. Reject — we never want to silently relativize a
    // user-supplied URL against the app origin.
    return null;
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;

  // Reject embedded credentials — these never belong in a saved bookmark
  // and are a known phishing/spoofing vector.
  if (parsed.username || parsed.password) return null;

  return parsed.toString();
}

/**
 * Best-effort domain extraction for display purposes ONLY. Never use the
 * returned value for security decisions — that's the worker's job.
 */
export function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'link';
  }
}

/**
 * Normalize free-form text for safe display in non-rich contexts.
 *
 * React already escapes text children, so this is belt-and-braces — we strip
 * NULL bytes and other C0 control characters that can confuse downstream
 * tooling (logs, CSV exports, screen readers) and collapse runs of whitespace.
 *
 * NEVER pipe the output of this through dangerouslySetInnerHTML. If you find
 * yourself wanting to, the answer is: don't.
 */
export function sanitizeText(raw: unknown, maxLen = 4000): string {
  if (typeof raw !== 'string') return '';
  // Strip C0 controls except tab (\x09), LF (\x0a), CR (\x0d).
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return stripped.length > maxLen ? stripped.slice(0, maxLen) : stripped;
}
