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
// Verbatim: no edits beyond import paths.
//
/**
 * Shared contract for the WebMCP audit feature: live quality auditing of
 * `navigator.modelContext` / `document.modelContext` tools exposed by
 * third-party sites. Both the backend capture/check/simulation engine and
 * the frontend report UI import these types - this is the single source of
 * truth for shape; nothing here has behaviour beyond the tiny helpers in
 * `checks.ts`.
 */

/** Overall capability verdict for one captured page. */
export type WebmcpVerdict =
  | "active"
  | "testing-only"
  | "declared-inactive"
  | "api-empty"
  | "blocked"
  | "load-error"
  | "absent";

/** Terminal (and in-flight) status of a whole audit run. */
export type WebmcpAuditStatus =
  | "ok"
  | "no-tools"
  | "unreachable"
  | "waf-blocked"
  | "stub-only"
  | "error"
  | "running";

/**
 * The four pillars a WebMCP audit grades, AFTER the availability gate
 * (`deriveAvailability`, in the engine's scoring module) has decided the
 * page is agent-ready at all - availability is a gate, never a scored
 * category, so a page no agent can use never wears a number:
 *
 *  - `shared-experience` (30): people and agents share this page - the human
 *    path still works, tools have visible counterparts, and the UI chrome an
 *    agent surface shows the person is filled in.
 *  - `task-completion` (25): could an agent actually get a task done here -
 *    selection accuracy against canonical intents, and coverage of what a
 *    site of this kind is for.
 *  - `tool-quality` (25): are the tool contracts built right - schemas,
 *    descriptions, names, handlers, entry points, registration health.
 *  - `trust` (20): can an agent trust what the tools declare - honest
 *    behaviour hints, no instruction-override surface in the metadata.
 */
export type WebmcpCategory =
  | "shared-experience"
  | "task-completion"
  | "tool-quality"
  | "trust";

/**
 * The availability gate's verdict for one audit. Derived at read time from the
 * capture (never stored): `ready` means an in-browser agent consuming the
 * JavaScript API finds tools it can call today; `not-ready` means it does not,
 * with `reasons` saying why in the report's own words; `unknown` means the
 * capture never got to look (or the row predates this score model).
 */
export type WebmcpAvailabilityStatus = "ready" | "not-ready" | "unknown";

export type WebmcpAvailabilityReasonId =
  | "native-api"
  | "origin-trial"
  | "tools-callable"
  | "no-tools"
  | "declarative-only"
  | "stub-tools"
  | "iframe-only"
  | "not-captured"
  | "legacy-model";

export interface WebmcpAvailabilityReason {
  id: WebmcpAvailabilityReasonId;
  /** One reader-facing sentence. */
  detail: string;
}

export interface WebmcpAvailability {
  status: WebmcpAvailabilityStatus;
  reasons: WebmcpAvailabilityReason[];
}

/**
 * One check's verdict. Two of these mean "no score", and the difference is
 * load-bearing:
 *
 *  - `na`: genuinely inapplicable - the surface has nothing for this check to
 *    measure (no imperative tools, no coverage baseline, a clean-by-design
 *    review). The site is not charged and the audit is not incomplete.
 *  - `unmeasured`: applicable but not measured - the model was unconfigured,
 *    a transport failed, no screenshot was taken, or the model output was
 *    unusable. The details string carries the cause. Scoring excludes it like
 *    `na`, but it counts AGAINST evidence coverage (see
 *    `webmcpEvidenceCoverage`, in the engine's scoring module).
 */
export type WebmcpCheckStatus = "pass" | "warning" | "fail" | "na" | "unmeasured";

/**
 * The 16 WebMCP audit check ids. Defined here (not in `checks.ts`) so
 * `WebmcpFinding.checkId` below can be typed against it without a
 * types.ts <-> checks.ts import cycle; `checks.ts` re-exports this symbol so
 * `import { type WebmcpCheckId } from "./checks"` keeps working for
 * consumers of the registry.
 *
 * Retired ids still found on stored rows (dropped by every consumer via the
 * registry lookup, and re-audited away by the forced re-seed):
 * `tools-registered` and `real-browser-eligible` became the availability gate
 * (`deriveAvailability`), and `toolchange-coherence` was deleted outright -
 * the shim only ever counted PAGE-dispatched toolchange events, and the spec
 * says the UA fires that event, so the check scored a thing sites must never
 * do.
 *
 * A `title-present` check (the spec's top-level human-readable `title`) is
 * deliberately NOT here yet: the spec defines `title` as a sibling of
 * `annotations` on the tool descriptor, and the Stage 1 shim only records the
 * annotations bag - a check readable today would score spec-compliant sites
 * as untitled. It joins in Stage 2, when the shim (bumped anyway) records the
 * spec field.
 */
export type WebmcpCheckId =
  | "registration-timing"
  | "canonical-entry-point"
  | "schema-validity"
  | "schema-quality"
  | "description-quality"
  | "naming-quality"
  | "stub-detection"
  | "tool-selection"
  | "coverage-vs-site-type"
  | "annotations-present"
  | "annotation-mismatch"
  | "injection-surface"
  | "untrusted-content-hint"
  | "registration-errors"
  | "human-parity"
  | "page-experience";

export interface WebmcpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  untrustedContentHint?: boolean;
  title?: string;
}

/** One tool discovered on a captured page, however it was registered. */
export interface WebmcpTool {
  name: string;
  description: string;
  via: "imperative" | "declarative";
  entryPoint: "navigator" | "document" | "provideContext" | "form";
  /** Page the tool was discovered on (a capture can cover multiple pages). */
  pageUrl: string;
  /** Raw JSON Schema the tool declares for its input - shape is unvalidated
   * here; `schema-validity` / `schema-quality` checks parse it. */
  inputSchema: unknown;
  annotations: WebmcpToolAnnotations;
  hasExecute: boolean;
  /** Time from navigation to this tool appearing in the registry, or `null`
   * when it could not be measured (e.g. present before the shim attached). */
  registrationMs: number | null;
}

export interface WebmcpOriginTrial {
  present: boolean;
  valid: boolean;
  expiresAt?: string;
  origin?: string;
  feature?: string;
}

/** What a real WebMCP-capable browser would actually see on this page,
 * independent of what the audit's own capture shim reports. */
export interface WebmcpConsumerReality {
  nativeApi: boolean;
  originTrial: WebmcpOriginTrial | null;
  permissionsPolicy: string | null;
  iframeAllow: boolean | null;
}

/**
 * Static (non-executed) WebMCP evidence pulled from HTML/JS source - mirrors
 * the shape produced by `collectStaticSignals` in
 * `collectStaticSignals` (see ./static-signals.ts). Kept as a structural
 * shape here rather than imported so `types.ts` has no dependency on that
 * module; the two are kept in sync by contract, not by import.
 */
export interface WebmcpStaticSignals {
  imperative: { marker: string; deprecatedAliasOnly: boolean } | null;
  polyfillPackages: string[];
  keywordMention: boolean;
}

export interface WebmcpApiSurface {
  toolchangeEvents: number;
  provideContextCalls: number;
  registrationErrors: string[];
}

export interface WebmcpCaptureTiming {
  navMs: number;
  quietMs: number;
  totalMs: number;
}

/** Capture result for a single page visited during an audit. */
export interface WebmcpPageCapture {
  url: string;
  finalUrl: string;
  verdict: WebmcpVerdict;
  status: WebmcpAuditStatus;
  tools: WebmcpTool[];
  declarativeFormCount: number;
  consumer: WebmcpConsumerReality;
  staticSignals: WebmcpStaticSignals;
  apiSurface: WebmcpApiSurface;
  timing: WebmcpCaptureTiming;
  error: string | null;
}

/**
 * A viewport screenshot of the entry page, taken during the no-shim pass so it
 * shows what a person actually sees. It feeds the `page-experience` check and
 * then PERSISTS with the capture (owner call, 2026-08-29; it was stripped
 * before): the report's run panel shows it as the idle image when the domain
 * has no recorded agent run. The report page is its only wire - the public
 * REST/MCP projection (`projectCapture`) rebuilds field by field and does not
 * carry it, and list surfaces read the blob-free summary.
 */
export interface WebmcpScreenshot {
  /** Base64-encoded image bytes (no data-URL prefix). */
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}

/** Whole-run capture output: one or more pages captured under one browser
 * session. */
export interface WebmcpCaptureResult {
  url: string;
  pages: WebmcpPageCapture[];
  chromeVersion: string;
  shimVersion: string;
  capturedAt: string;
  durationMs: number;
  /** Entry-page screenshot, when the capture managed to take one. Absent on
   * pre-screenshot captures and on blocked/failed pages. */
  screenshot?: WebmcpScreenshot | null;
}

/** One check's verdict against a capture. `score` is a 0..1 fraction of the
 * check's registry weight earned - multiply by `WEBMCP_CHECKS[checkId].weight`
 * to get points, never re-derive the weight elsewhere. */
export interface WebmcpFinding {
  checkId: WebmcpCheckId;
  category: WebmcpCategory;
  status: WebmcpCheckStatus;
  score: number;
  details: string;
  toolName: string | null;
  evidence: string | null;
}

export type WebmcpCategoryScores = Record<WebmcpCategory, number>;

/** One simulated "would an agent actually call the right tool" step. */
export interface WebmcpSimulationStep {
  intent: string;
  expectedKind: string;
  chosenTool: string | null;
  args: unknown;
  toolExists: boolean;
  argsValid: boolean;
  /**
   * Does the chosen tool look like the kind of tool the intent needs, judged
   * in code against the expected capability's word-bounded terms? `null` when
   * there is nothing to judge - no oracle exists for the intent (generic
   * category), or no registered tool was chosen. Optional because steps stored
   * before this field existed do not carry it; absent means the same as `null`.
   */
  kindMatched?: boolean | null;
  ok: boolean;
}

export interface WebmcpSimulation {
  steps: WebmcpSimulationStep[];
  accuracy: number;
  model: string;
  skipped: boolean;
  skipReason: string | null;
}

/** The full stored/streamed audit record. */
export interface WebmcpAudit {
  id: string;
  domain: string;
  url: string;
  status: WebmcpAuditStatus;
  verdict: WebmcpVerdict;
  score: number | null;
  grade: string | null;
  categoryScores: WebmcpCategoryScores;
  /**
   * 0..100: how much of the applicable check weight was actually measured
   * (`webmcpEvidenceCoverage` over the findings at completion time), persisted
   * so the blob-free list surfaces (ranking, badge, OG card) can apply the
   * grade-withholding gate without loading `checks_json`. `null` on rows
   * written before this column existed AND before the backfill classified
   * them - a null keeps ranking until the backfill closes that window.
   */
  evidenceCoverage: number | null;
  findings: WebmcpFinding[];
  capture: WebmcpCaptureResult | null;
  simulation: WebmcpSimulation | null;
  toolCount: number;
  pageCount: number;
  mode: "fast" | "deep";
  /**
   * What caused this run. `"local"` is the one member that never reaches a
   * database row: it marks an audit whose capture was produced on a
   * developer's own machine and posted to `POST /api/webmcp/audit/ingest`,
   * which is scored and returned but never persisted. It exists so a response
   * from that path can never be mistaken for a published measurement - see
   * docs/api.md, WebMCP audit surface.
   */
  source: "user" | "seed" | "cron" | "local";
  chromeVersion: string;
  shimVersion: string;
  specSnapshot: string;
  /** `null` while `status === "running"` - a duration only exists once the
   * run has stopped (successfully or not). */
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * SSE event union for a live audit stream. Naming/shape follows the scan
 * stream's discriminated-union-on-`type` idiom (see
 * `src/hooks/live-scan-stream/sse-event-handlers.ts`), narrowed to the events
 * this feature actually emits.
 */
export type WebmcpAuditEvent =
  | { type: "phase"; phase: "capture" | "checks" | "simulation" | "persist" }
  | {
      type: "page-captured";
      path: string;
      toolCount: number;
      verdict: WebmcpVerdict;
    }
  | { type: "tool-discovered"; tool: WebmcpTool }
  | { type: "finding"; finding: WebmcpFinding }
  | { type: "simulation-step"; step: WebmcpSimulationStep }
  | { type: "done"; audit: WebmcpAudit }
  | { type: "error"; message: string; status: WebmcpAuditStatus };
