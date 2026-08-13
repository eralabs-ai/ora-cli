// The library surface of @ora-ai/ax: the same contract-typed client the CLI
// commands use, importable as `import { audit } from "@ora-ai/ax"`. The bin
// stays a separate self-contained bundle - this entry ships unminified with
// type declarations and has no runtime dependencies.

export {
	AuditApiError,
	type AuditOptions,
	type AuditOutcome,
	type AuditResult,
	performAudit as audit,
} from "./api/audit";
export {
	type FetchedSkill,
	fetchSkill,
	fetchSkillIndex,
	SkillApiError,
	type SkillEntry,
} from "./api/skills";
export {
	type AuditCheck,
	type AuditLayer,
	type AuditScanResult,
	type AuditScoreResult,
	type AuditTopFix,
	BUILT_AGAINST,
	isNewerContract,
} from "./contract";
