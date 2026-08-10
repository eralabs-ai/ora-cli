import type { Report } from "./model";

// The machine-readable result. Deliberately complete: every check — passing,
// failing, or skipped — is present no matter which --show-* flags were given,
// so scripts never depend on display options.

function slugOf(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "");
}

export function reportJson(report: Report): string {
	const body = {
		url: report.url,
		score: report.score,
		rating: report.rating,
		summary: report.summary,
		categories: Object.fromEntries(
			report.sections.map((section) => [
				slugOf(section.name),
				{
					passed: section.passed,
					total: section.total,
					skipped: section.skipped,
					checks: section.checks.map((check) => ({
						name: check.name,
						status: check.status,
						passed: check.passed,
						skipped: check.skipped ?? false,
						tier: check.tier,
						estScoreGain: check.estScoreGain,
						detail: check.detail,
						hint: check.hint,
						url: check.url,
					})),
				},
			]),
		),
	};
	return JSON.stringify(body, null, 2);
}
