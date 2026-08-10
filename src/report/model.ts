import type { ScanCheck, ScanCheckStatus, ScanResult } from "../api/scan";

// The report model the renderers consume, plus the mapping from ora's raw
// ScanResult into it. Kept separate from the API client so the wire shape can
// evolve without touching presentation.

export type CheckTier = "required" | "recommended" | "optional";

export const TIER_RANK: Record<CheckTier, number> = { required: 0, recommended: 1, optional: 2 };

export interface AuditCheck {
	name: string;
	passed: boolean;
	skipped?: boolean;
	/** The finding — what the scan observed. */
	detail?: string;
	/** The fix — what to implement. */
	hint?: string;
	url?: string;
	tier: CheckTier;
	/** ora's raw verdict for this check, when known. */
	status?: ScanCheckStatus;
	/** Estimated points recovered by fixing this check, when known. */
	estScoreGain?: number;
}

export interface AuditSection {
	name: string;
	checks: AuditCheck[];
	/** Passing count among non-skipped checks. */
	passed: number;
	/** Non-skipped check count. */
	total: number;
	skipped: number;
}

export interface AuditReport {
	url: string;
	score: number;
	rating: string;
	/** ora's one-line agentic verdict, when it arrived. */
	summary?: string;
	sections: AuditSection[];
}

export function ratingFor(score: number): string {
	if (score >= 90) return "Excellent";
	if (score >= 70) return "Good";
	if (score >= 50) return "Fair";
	return "Needs Improvement";
}

export function sectionOf(name: string, checks: AuditCheck[]): AuditSection {
	const counted = checks.filter((c) => !c.skipped);
	return {
		name,
		checks,
		passed: counted.filter((c) => c.passed).length,
		total: counted.length,
		skipped: checks.length - counted.length,
	};
}

/**
 * ora has no required/recommended/optional notion; approximate one from each
 * check's weight relative to the heaviest check in its layer, so the report
 * can keep a "most important first" ordering.
 */
function tierOf(weight: number, heaviest: number): CheckTier {
	if (heaviest <= 0) return "recommended";
	const share = weight / heaviest;
	if (share >= 0.75) return "required";
	if (share >= 0.4) return "recommended";
	return "optional";
}

function convertCheck(raw: ScanCheck, heaviest: number): AuditCheck {
	// pass → passed; na/pending → skipped (kept out of every count);
	// fail/warning/error all surface as issues (warning just gets a softer glyph).
	const passed = raw.status === "pass";
	const skipped = raw.status === "na" || raw.status === "pending";

	const check: AuditCheck = {
		name: raw.name,
		passed,
		tier: tierOf(raw.maxScore ?? 0, heaviest),
		status: raw.status,
	};
	if (skipped) check.skipped = true;
	if (raw.details) check.detail = raw.details;
	if (typeof raw.estScoreGain === "number") check.estScoreGain = raw.estScoreGain;
	// The how-to-fix column must come from `recommendation` (the remedy) and
	// never `description` (a restatement of what the check inspects).
	if (!passed && !skipped && raw.recommendation) check.hint = raw.recommendation;
	return check;
}

export function toAuditReport(scan: ScanResult, requestedUrl: string): AuditReport {
	const sections = (scan.layers ?? []).map((layer) => {
		const heaviest = layer.checks.reduce((top, c) => Math.max(top, c.maxScore ?? 0), 0);
		return sectionOf(
			layer.name,
			layer.checks.map((c) => convertCheck(c, heaviest)),
		);
	});

	const score = Math.min(100, Math.max(0, Math.round(scan.score ?? 0)));

	return {
		url: scan.url ?? requestedUrl,
		score,
		rating: ratingFor(score),
		summary: scan.agenticSummary,
		sections,
	};
}
