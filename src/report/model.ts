import type { AuditOutcome, AuditResult } from "../api/audit";
import type { AuditScanResult, AuditTopFix } from "../contract";

// The report model the terminal renderer consumes, mapped 1:1 from ora's
// audit payload. Thin client rule: no interpretation happens here - the grade
// comes from the API, the fix ranking is the payload's topFixes verbatim, and
// tiers are not re-derived (ora's tiers are display-only and never determine
// score, so the report does not bucket by them).

export interface ReportCheck {
	id: string;
	name: string;
	passed: boolean;
	skipped?: boolean;
	/** The finding — what the scan observed. */
	detail?: string;
	/** The fix — what to implement (the payload's `recommendation`). */
	hint?: string;
	/** Canonical spec / standard URL for the check, when ora publishes one. */
	specUrl?: string;
	/** ora's raw verdict for this check. */
	status: string;
	/** Estimated 0-100 points recovered by fixing this check (an estimate). */
	estScoreGain?: number;
}

export interface ReportSection {
	name: string;
	checks: ReportCheck[];
	/** Passing count among non-skipped checks. */
	passed: number;
	/** Non-skipped check count. */
	total: number;
	skipped: number;
}

export interface Report {
	/** What the user asked to audit (display only). */
	target: string;
	score: number;
	/** ora's letter grade, straight from the payload. */
	grade: string;
	/** ora's one-line agentic verdict, when it arrived. */
	summary?: string;
	sections: ReportSection[];
	/** The payload's server-ranked fix list, order untouched. */
	topFixes: AuditTopFix[];
	/** Canonical ora.ai deep link for the full report. */
	reportUrl: string;
	/** Present when the freshness gate served a stored result. */
	cacheAgeSeconds?: number;
	analysisStatus?: string;
	/** MCP handshake demanded credentials: score 0 means "could not evaluate". */
	mcpAuthRequired?: boolean;
}

export function sectionOf(name: string, checks: ReportCheck[]): ReportSection {
	const counted = checks.filter((c) => !c.skipped);
	return {
		name,
		checks,
		passed: counted.filter((c) => c.passed).length,
		total: counted.length,
		skipped: checks.length - counted.length,
	};
}

function convertCheck(raw: AuditResult["layers"][number]["checks"][number]): ReportCheck {
	// pass → passed; na/pending → skipped (kept out of every count);
	// fail/warning/error all surface as issues (warning just gets a softer glyph).
	const passed = raw.status === "pass";
	const skipped = raw.status === "na" || raw.status === "pending";

	const check: ReportCheck = {
		id: raw.id,
		name: raw.name,
		passed,
		status: raw.status,
	};
	if (skipped) check.skipped = true;
	if (skipped && raw.naReason) check.detail = raw.naReason;
	else if (raw.details) check.detail = raw.details;
	if (typeof raw.estScoreGain === "number") check.estScoreGain = raw.estScoreGain;
	if (raw.specUrl) check.specUrl = raw.specUrl;
	// The how-to-fix column must come from `recommendation` (the remedy) and
	// never `details` (the observation).
	if (!passed && !skipped && raw.recommendation) check.hint = raw.recommendation;
	return check;
}

export function toReport(outcome: AuditOutcome, requestedUrl: string): Report {
	const { result } = outcome;
	const sections = (result.layers ?? []).map((layer) =>
		sectionOf(layer.name, (layer.checks ?? []).map(convertCheck)),
	);

	const report: Report = {
		target: result.domain || requestedUrl,
		score: result.score,
		grade: result.grade,
		summary: outcome.verdict,
		sections,
		topFixes: result.topFixes ?? [],
		reportUrl: result.url,
		analysisStatus: result.analysisStatus,
	};
	// Freshness provenance rides scan-shaped payloads only.
	const scanShaped = result as AuditScanResult;
	if (scanShaped.servedFromCache && typeof scanShaped.resultAgeSeconds === "number") {
		report.cacheAgeSeconds = scanShaped.resultAgeSeconds;
	}
	if (result.mcpAuthRequired) report.mcpAuthRequired = true;
	return report;
}
