import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import pkg from "../package.json";
import { auditCommand } from "./commands/audit";
import { journeyCommand } from "./commands/journey";

const NAME = "ax";

const audit = defineCommand({
	meta: {
		name: "audit",
		description: "Score a site's agent readiness",
	},
	args: {
		url: {
			type: "positional",
			description: "URL to audit (e.g. https://docs.example.com)",
			required: true,
		},
		json: { type: "boolean", description: "Output as JSON", default: false },
		"min-score": { type: "string", description: "Exit 1 when the score is under n" },
		"show-passing": {
			type: "boolean",
			description: "List each passing check individually",
			default: false,
		},
		"show-skipped": {
			type: "boolean",
			description: "List not-applicable / pending checks too",
			default: false,
		},
	},
	async run({ args }) {
		let minScore: number | null = null;
		if (args["min-score"] !== undefined) {
			const parsed = Number(args["min-score"]);
			if (!Number.isFinite(parsed)) {
				console.error(`Invalid --min-score: ${args["min-score"]}`);
				process.exit(2);
			}
			minScore = parsed;
		}
		process.exit(
			await auditCommand({
				url: args.url as string,
				json: Boolean(args.json),
				minScore,
				showSkipped: Boolean(args["show-skipped"]),
				showPassing: Boolean(args["show-passing"]),
			}),
		);
	},
});

const journey = defineCommand({
	meta: {
		name: "journey",
		description: "Send a real AI agent at a site and watch it navigate live",
	},
	args: {
		intent: {
			type: "positional",
			description: 'Goal for the agent (e.g. "Find the API docs and how to auth")',
			required: true,
		},
		domain: { type: "string", description: "Site the agent targets (e.g. stripe.com)" },
		harness: {
			type: "string",
			description: "Agent harness: claude-code, codex, aider, …",
			default: "claude-code",
		},
		model: { type: "string", description: "Model override (harness default when omitted)" },
		json: { type: "boolean", description: "Output as JSON", default: false },
	},
	async run({ args }) {
		process.exit(
			await journeyCommand({
				intent: args.intent as string,
				domain: args.domain as string | undefined,
				harness: args.harness as string,
				model: args.model as string | undefined,
				json: Boolean(args.json),
			}),
		);
	},
});

function helpScreen(): string {
	const g = pc.green("$");
	const d = pc.dim;
	return [
		"",
		`  ${pc.bold(NAME)} ${d(`v${pkg.version}`)}`,
		`  ${d("Score any site's agent readiness — and watch real AI agents navigate it")}`,
		"",
		`  ${d("Commands:")}`,
		`    audit ${d("<url>")}       ${d("Score a site's agent readiness")}`,
		`    journey ${d("<intent>")}  ${d("Send a real agent at a site and watch it live")}`,
		"",
		`  ${d("Examples:")}`,
		`    ${g} ${NAME} audit https://docs.example.com`,
		`    ${g} ${NAME} audit https://docs.example.com --min-score 70`,
		`    ${g} ${NAME} journey "Find the API docs and how to authenticate" --domain stripe.com`,
		`    ${g} ${NAME} journey "Sign up for an account" --domain example.com --harness codex`,
		"",
		`  ${d("audit options:")}`,
		`    --json           ${d("Output as JSON")}`,
		`    --min-score <n>  ${d("Exit 1 when the score is under n")}`,
		`    --show-passing   ${d("List each passing check (hidden by default)")}`,
		`    --show-skipped   ${d("List skipped checks (hidden by default)")}`,
		"",
		`  ${d("journey options:")}`,
		`    --domain <d>     ${d("Site the agent targets (e.g. stripe.com)")}`,
		`    --harness <h>    ${d("Agent harness: claude-code, codex, aider, … (default claude-code)")}`,
		`    --model <m>      ${d("Model override (harness default when omitted)")}`,
		`    --json           ${d("Output as JSON")}`,
		`    ${d("requires ORA_API_KEY (see .env.example)")}`,
		"",
	].join("\n");
}

const root = defineCommand({
	meta: {
		name: NAME,
		version: pkg.version,
		description: "Score any site's agent readiness — and watch real AI agents navigate it",
	},
	subCommands: { audit, journey },
	setup() {
		// Bare invocation and top-level --help get the curated screen; subcommand
		// --help stays with citty's generated usage.
		const first = process.argv[2];
		if (!first || first === "--help" || first === "-h") {
			console.log(helpScreen());
			process.exit(0);
		}
	},
});

runMain(root);
