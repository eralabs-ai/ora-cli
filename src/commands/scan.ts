import { performScan } from "../api/scan";
import { reportJson } from "../report/json";
import { type Report, toReport } from "../report/model";
import { renderReport } from "../report/terminal";
import { spinner } from "../ui/spinner";

export interface ScanCommandInput {
	url: string;
	json: boolean;
	showSkipped: boolean;
	showPassing: boolean;
}

// Exit codes: 0 scan ok · 2 anything went wrong.
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

	return 0;
}
