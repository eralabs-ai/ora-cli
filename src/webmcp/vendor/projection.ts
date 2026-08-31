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
// This one is the PUBLISHED shape, not the stored one: the ingest endpoint's
// terminal `done` frame carries the projection, which differs from the internal
// record in ways the report depends on - it adds `contractVersion` and the
// derived `availability` gate, and its `evidenceCoverage` is never null.
//
import type {
  WebmcpAudit,
  WebmcpAuditStatus,
  WebmcpAvailability,
  WebmcpCaptureResult,
  WebmcpCategoryScores,
  WebmcpFinding,
  WebmcpSimulation,
  WebmcpVerdict,
} from "./types";

/**
 * The published audit record. Declared field by field rather than derived from
 * `WebmcpAudit`, so growth of the internal record is a decision rather than a
 * default; the leaf types are shared with the internal contract because the
 * projector rebuilds each of them field by field too (a new required field on
 * any of them fails to compile right here).
 */
export interface PublicWebmcpAudit {
  contractVersion: string;
  id: string;
  domain: string;
  url: string;
  status: WebmcpAuditStatus;
  verdict: WebmcpVerdict;
  score: number | null;
  grade: string | null;
  categoryScores: WebmcpCategoryScores;
  /** The availability gate's verdict, derived from the capture at projection
   * time (never stored). Full record only: a summary row has no capture to
   * derive from. */
  availability: WebmcpAvailability;
  /** The stored per-run coverage when the row carries one, else derived from
   * the findings at projection time. Full record only: a summary row has no
   * findings to fall back to. */
  evidenceCoverage: number;
  findings: WebmcpFinding[];
  capture: WebmcpCaptureResult | null;
  simulation: WebmcpSimulation | null;
  toolCount: number;
  pageCount: number;
  mode: WebmcpAudit["mode"];
  source: WebmcpAudit["source"];
  chromeVersion: string;
  shimVersion: string;
  specSnapshot: string;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
