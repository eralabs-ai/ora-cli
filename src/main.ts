import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import pkg from "../package.json";
import { auditCommand } from "./commands/audit";
import { journeyCommand } from "./commands/journey";
import { loadLocalEnv } from "./env";

const NAME = "ax";

const audit = defineCommand({
	meta: {
		name: "audit",
		description:
			"Score a site's agent readiness (exit codes: 0 ok, 1 below --min-score, 2 usage, 3 API error)",
	},
	args: {
		url: {
			type: "positional",
			description: "URL or domain to audit (e.g. https://docs.example.com)",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Print the raw ora audit payload as JSON",
			default: false,
		},
		"min-score": {
			type: "string",
			description: "Exit 1 when the score is below this threshold (0-100); the CI gate",
		},
		"max-age": {
			type: "string",
			description: "Accept a cached result up to this many seconds old (server default 6h)",
		},
		force: {
			type: "boolean",
			description: "Bypass the cache and rescan (spends the stricter 6/day force budget)",
			default: false,
		},
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
		// exitCode, not process.exit(): a large --json payload can exceed the
		// 64KB pipe buffer, and process.exit() drops whatever stdout has not
		// flushed yet. Setting exitCode lets Node drain stdout, then exit.
		process.exitCode = await auditCommand({
			url: args.url as string,
			json: Boolean(args.json),
			showSkipped: Boolean(args["show-skipped"]),
			showPassing: Boolean(args["show-passing"]),
			minScore: args["min-score"] as string | undefined,
			maxAge: args["max-age"] as string | undefined,
			force: Boolean(args.force),
		});
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
			description: "Agent harness: claude-code, codex, openclaw, hermess, claude-agent, eve, …",
			default: "claude-code",
		},
		model: { type: "string", description: "Model override (harness default when omitted)" },
		json: { type: "boolean", description: "Output as JSON", default: false },
	},
	async run({ args }) {
		// Same exitCode-over-exit rule as audit: let stdout drain before exiting.
		process.exitCode = await journeyCommand({
			intent: args.intent as string,
			domain: args.domain as string | undefined,
			harness: args.harness as string,
			model: args.model as string | undefined,
			json: Boolean(args.json),
		});
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
		`    ${g} ${NAME} audit https://docs.example.com --min-score 70   ${d("# CI gate")}`,
		`    ${g} ${NAME} audit https://docs.example.com --json`,
		`    ${g} ${NAME} journey "Find the API docs and how to authenticate" --domain stripe.com`,
		"",
		`  ${d("audit options:")}`,
		`    --min-score <n>  ${d("Exit 1 when the score is below n (0-100); the CI gate")}`,
		`    --max-age <s>    ${d("Accept a cached result up to s seconds old (default 6h)")}`,
		`    --force          ${d("Bypass the cache and rescan (6/day budget)")}`,
		`    --json           ${d("Print the raw ora audit payload as JSON")}`,
		`    --show-passing   ${d("List each passing check (hidden by default)")}`,
		`    --show-skipped   ${d("List skipped checks (hidden by default)")}`,
		"",
		`  ${d("audit exit codes:")}`,
		`    ${d("0 success · 1 below --min-score · 2 usage error · 3 API unreachable/rate-limited")}`,
		"",
		`  ${d("journey options:")}`,
		`    --domain <d>     ${d("Site the agent targets (e.g. stripe.com)")}`,
		`    --harness <h>    ${d("Agent harness: claude-code (default), codex, openclaw, hermess, claude-agent, eve, …")}`,
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

// Before anything reads process.env — every command resolves its configuration
// at call time, so the file has to be in place first.
loadLocalEnv();

runMain(root);
