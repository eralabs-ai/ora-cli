import { performScan } from "../api/scan";
import { reportJson } from "../report/json";
import { type Report, toReport } from "../report/model";
import { renderReport } from "../report/terminal";
import { spinner } from "../ui/spinner";

export interface ScanCommandInput {
	url: string;
	json: boolean;
	minScore: number | null;
	showSkipped: boolean;
	showPassing: boolean;
}

// Exit codes: 0 scan ok (and above --min-score when given) · 1 under the
// threshold · 2 anything went wrong.
export async function scanCommand(input: ScanCommandInput): Promise<number> {
	const target = input.url.replace(/\/+$/, "");
	const interactive = !input.json;

	if (interactive) spinner.start(`Scanning ${target} with ora`);

	let report: Report;
	try {
		const scan = await performScan(target, {
			progress: interactive ? (line) => spinner.update(line) : undefined,
		});
		report = toReport(scan, target);
	} catch (cause) {
		spinner.stop();
		console.error(`Scan failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		return 2;
	}
	spinner.stop();

	if (input.json) {
		process.stdout.write(`${reportJson(report)}\n`);
	} else {
		for (const line of renderReport(report, {
			showSkipped: input.showSkipped,
			showPassing: input.showPassing,
		})) {
			console.log(line);
		}
	}

	if (input.minScore !== null && report.score < input.minScore) {
		if (interactive) console.log(`Score ${report.score} is below minimum ${input.minScore}`);
		return 1;
	}
	return 0;
}
