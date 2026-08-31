// Copied from ora's WebMCP audit engine. DO NOT EDIT BY HAND.
//
// `ax webmcp-audit` captures a page here and ora scores it there. Both sides
// have to measure the same thing or a developer gets one answer locally and a
// different one from the published audit, so this file is a COPY of the
// engine's own code rather than a reimplementation of it.
//
// What pins the two together is the capture shim version - `WEBMCP_SHIM_VERSION`
// in ./checks.ts. The ingest endpoint refuses a capture taken by any other
// version. Note what that does NOT catch: the engine can change this code
// without changing the version, and it has. Re-copy the whole directory
// whenever the engine moves; do not trust the version check to notice.
//
// To update: re-copy from the engine and rewrite the import paths. Never patch
// it here - a change that belongs in the engine has to be made there first, or
// the two stop agreeing.
//
// One thing the re-copy must redo: the engine's comments cite its own source
// paths, and those are rewritten to point at files in THIS directory. Nothing
// executable differs.
//
// Verbatim, but only the two challenge predicates: they decide a page's
// `blocked` verdict. The module they come from is a whole signed-fetch stack
// that this CLI has no other use for.
//
function isCloudflareChallengeResponse(status: number, headers: Record<string, string>, text: string): boolean {
  if (headers["cf-mitigated"] === "challenge") return true;
  if (status === 403 && text.includes("cf-browser-verification")) return true;
  if (status === 503 && text.includes("challenge-platform")) return true;
  return false;
}

export function isSecurityChallenge(status: number, _headers: Record<string, string>, text: string): boolean {
  if (isCloudflareChallengeResponse(status, _headers, text)) return true;
  // Vercel: headers first. Body-string matching alone missed challenges whose
  // interstitial did not carry the literal marker, and a missed challenge is
  // worse than a false one - the challenge page gets scored as the customer's
  // real content, nulling every content-dependent check. (Ported from #954.)
  if (_headers["x-vercel-mitigated"] === "challenge") return true;
  if ("x-vercel-challenge-token" in _headers) return true;
  // Vercel Security Checkpoint body fallback
  if (text.includes("Vercel Security Checkpoint")) return true;
  if (text.includes("vercel-challenge")) return true;
  // Generic WAF / bot protection signals
  if (status === 429 && text.length < 2000) return true;
  if (status === 403 && (text.includes("Access Denied") || text.includes("Bot Protection"))) return true;
  return false;
}
