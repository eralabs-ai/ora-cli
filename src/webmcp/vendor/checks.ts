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
import type { WebmcpCategory, WebmcpCheckId } from "./types";

/**
 * Check id registry for the WebMCP audit. Every check id, its title, and its
 * category are fixed here - checks.ts is pure data + tiny helpers, no
 * behaviour, so the capture/scoring engine and the report UI both import it
 * as the single source of truth.
 *
 * `WebmcpCheckId` itself is defined in `types.ts` (so `WebmcpFinding.checkId`
 * can be typed against it without a types.ts <-> checks.ts import cycle) and
 * re-exported here so existing `import { type WebmcpCheckId } from "./checks"`
 * call sites keep working.
 */
export type { WebmcpCheckId };

export interface WebmcpCheckDefinition {
  title: string;
  category: WebmcpCategory;
  /** Points this check is worth within its category. Per-category weights
   * sum to `WEBMCP_CATEGORY_WEIGHTS[category]` - see `checks.spec.ts`. */
  weight: number;
  docSlug: string;
}

/**
 * Pillar weights, out of 100. Availability is deliberately NOT a pillar:
 * whether an agent can use the page at all is a GATE (`deriveAvailability` in
 * the engine's scoring module), and a not-ready page carries no score
 * rather than a low one - so registering tools no agent can see never buys a
 * number, and an availability zero is never averaged into anything.
 */
export const WEBMCP_CATEGORY_WEIGHTS: Record<WebmcpCategory, number> = {
  "shared-experience": 30,
  "task-completion": 25,
  "tool-quality": 25,
  trust: 20,
};

export const WEBMCP_CHECKS: Record<WebmcpCheckId, WebmcpCheckDefinition> = {
  // Shared experience (30) - people and agents share this page.
  //
  // page-experience carries the most: it grades the page a person actually
  // sees (from the no-shim screenshot), and a site must not score well by
  // serving agents and no one else. human-parity reads whether the person
  // co-browsing can see and use what the agent acts on. A title-present
  // check (the spec's top-level `title`) joins in Stage 2 once the shim
  // records the spec field - see the note on `WebmcpCheckId`.
  "page-experience": {
    title: "Page experience",
    category: "shared-experience",
    weight: 20,
    docSlug: "page-experience",
  },
  "human-parity": {
    title: "Human parity",
    category: "shared-experience",
    weight: 10,
    docSlug: "human-parity",
  },

  // Task completion (25) - could an agent actually get a task done here.
  //
  // tool-selection carries the most: it is the closest thing this audit has to
  // watching a real agent try, and it is exactly Chrome's "call accuracy" eval
  // shape (pick the right tool with the right arguments for an intent).
  // Stage 2 adds invoke-success-rate here, with an intra-pillar rebalance.
  "tool-selection": {
    title: "Tool selection",
    category: "task-completion",
    weight: 15,
    docSlug: "tool-selection",
  },
  "coverage-vs-site-type": {
    title: "Coverage vs. site type",
    category: "task-completion",
    weight: 10,
    docSlug: "coverage-vs-site-type",
  },

  // Tool quality (25) - are the tool contracts built right.
  //
  // The schema/description/handler checks lead because a tool an agent cannot
  // parse or run has no working contract. naming-quality rests on a verb list
  // that can never be complete, so it warns rather than fails and carries
  // little; registration-timing is a note-weight check printed in whole ms.
  // The "execute missing its signal param" spec-completeness note joins in
  // Stage 2 - the Stage 1 capture only records that execute exists, and a
  // permanently unmeasured check would drag every audit's evidence coverage.
  "schema-validity": {
    title: "Schema validity",
    category: "tool-quality",
    weight: 4,
    docSlug: "schema-validity",
  },
  "schema-quality": {
    title: "Schema quality",
    category: "tool-quality",
    weight: 4,
    docSlug: "schema-quality",
  },
  "description-quality": {
    title: "Description quality",
    category: "tool-quality",
    weight: 5,
    docSlug: "description-quality",
  },
  "stub-detection": {
    title: "Stub detection",
    category: "tool-quality",
    weight: 4,
    docSlug: "stub-detection",
  },
  "canonical-entry-point": {
    title: "Canonical entry point",
    category: "tool-quality",
    weight: 3,
    docSlug: "canonical-entry-point",
  },
  "naming-quality": {
    title: "Naming quality",
    category: "tool-quality",
    weight: 2,
    docSlug: "naming-quality",
  },
  "registration-errors": {
    title: "Registration errors",
    category: "tool-quality",
    weight: 2,
    docSlug: "registration-errors",
  },
  "registration-timing": {
    title: "Registration timing",
    category: "tool-quality",
    weight: 1,
    docSlug: "registration-timing",
  },

  // Trust (20) - can an agent trust what the tools declare.
  //
  // The two annotation checks split the pillar's lead: an information-carrying
  // readOnlyHint is what lets an agent relax confirmation on reads, and a hint
  // the tool's own name or description contradicts poisons every hint in the
  // set. injection-surface reviews the METADATA an agent ingests (names,
  // descriptions, titles, schema descriptions) for instruction-override
  // patterns - a free-text parameter is never flagged; a search tool takes a
  // query.
  "annotations-present": {
    title: "Annotations present",
    category: "trust",
    weight: 6,
    docSlug: "annotations-present",
  },
  "annotation-mismatch": {
    title: "Annotation mismatch",
    category: "trust",
    weight: 6,
    docSlug: "annotation-mismatch",
  },
  "injection-surface": {
    title: "Injection surface",
    category: "trust",
    weight: 4,
    docSlug: "injection-surface",
  },
  "untrusted-content-hint": {
    title: "Untrusted content hint",
    category: "trust",
    weight: 4,
    docSlug: "untrusted-content-hint",
  },
};

// The WORKER's capture stamp: `capture-server.ts` (deployed separately, on
// Fly) reports it and the engine stores what the worker reported, so bumping
// it here without a worker redeploy only manufactures skew (shim_skew warns on
// every capture, and version-keyed staleness marks fresh audits stale).
// App-side vocabulary changes (e.g. the 2026-08-31 unmeasured/coverage split)
// do NOT move this number - forced re-audits are explicit
// (`scripts/webmcp-seed.ts --ignore-freshness`), and the 7-day fresh window
// plus the ranking's coverage gate handle organic healing.
export const WEBMCP_SHIM_VERSION = "1";
// The date the pinned spec read was actually taken (see the protocol-webmcp
// skill, which pins the same 2026-08-26 review); moves only when the read
// date moves.
export const WEBMCP_SPEC_SNAPSHOT = "2026-08-26";

/**
 * Git blob SHA of the normative spec source (index.bs in
 * webmachinelearning/webmcp) as reviewed for the protocol-webmcp skill. A
 * blob SHA rather than a repo commit so unrelated repo commits (explainer
 * edits, CI) never alert; the spec-drift-watch workflow compares the live
 * blob SHA against this pin, replacing the old date-cutoff signal (which
 * silently treated every commit on the snapshot date as reviewed). On
 * drift, re-verify and advance this pin together with the skill.
 */
export const WEBMCP_SPEC_SOURCE_SHA = "241bb2c014b10a646649cd2a0d147498925aa63a";

/** Grade bands for the WebMCP audit score. Deliberately NOT the scanner's
 * `GRADE_THRESHOLDS` (`src/config/scoring.ts`) - this is its own domain even
 * though the band style matches. */
const WEBMCP_GRADE_THRESHOLDS = {
  "A+": 95,
  A: 85,
  B: 70,
  C: 50,
  D: 30,
  F: 0,
} as const;

export function webmcpGrade(score: number): string {
  if (score >= WEBMCP_GRADE_THRESHOLDS["A+"]) return "A+";
  if (score >= WEBMCP_GRADE_THRESHOLDS.A) return "A";
  if (score >= WEBMCP_GRADE_THRESHOLDS.B) return "B";
  if (score >= WEBMCP_GRADE_THRESHOLDS.C) return "C";
  if (score >= WEBMCP_GRADE_THRESHOLDS.D) return "D";
  return "F";
}

/**
 * Short, copy-pastable JS fix snippet for a failing check, or `null` when
 * the check names a behavioural/measurement gap rather than a one-line code
 * fix (e.g. `tool-selection` is an outcome of description/schema quality,
 * not its own fixable call site). `tool` is the tool name to interpolate
 * when the snippet targets a specific tool; omit for site-wide checks.
 */
export function fixSnippetFor(
  checkId: WebmcpCheckId,
  tool?: string | null,
): string | null {
  const name = tool || "your_tool_name";
  switch (checkId) {
    case "canonical-entry-point":
      return `// document.modelContext is the canonical entry point - the navigator.modelContext alias is deprecated.\ndocument.modelContext.registerTool({ /* ... */ });`;
    case "registration-timing":
      return `// Register tools as soon as they're ready, not behind a deferred/async chunk.\ndocument.modelContext.registerTool({ /* ... */ });`;
    case "schema-validity":
      return `{\n  name: "${name}",\n  inputSchema: { type: "object", properties: { /* ... */ }, required: [] }\n}`;
    case "schema-quality":
      return `{\n  name: "${name}",\n  inputSchema: {\n    type: "object",\n    properties: {\n      query: { type: "string", description: "What to search for" }\n    },\n    required: ["query"]\n  }\n}`;
    case "description-quality":
      return `{\n  name: "${name}",\n  description: "Describe what this tool does, when to use it, and what it returns."\n}`;
    case "naming-quality":
      return `{ name: "${name.toLowerCase().replace(/\s+/g, "_")}" /* short, unique, verb-based */ }`;
    case "stub-detection":
      return `{\n  name: "${name}",\n  execute: async (args, { signal }) => {\n    // Perform the real action here - return live data, not a static placeholder.\n    // Pass signal to any fetch so cancellation propagates.\n    return result;\n  }\n}`;
    case "annotations-present":
      return `{\n  name: "${name}",\n  // Declare readOnlyHint: true on tools that truly have no side effects -\n  // that is the claim that lets an agent relax confirmation on reads.\n  // (false is the default, so declaring it adds no information.)\n  annotations: { readOnlyHint: true }\n}`;
    case "annotation-mismatch":
      return `// readOnlyHint must match what the tool actually does - drop it (or set false) on a tool that writes.\n{ name: "${name}", annotations: { readOnlyHint: false } }`;
    case "injection-surface":
      return `{\n  name: "${name}",\n  // Metadata DESCRIBES the tool - it never addresses the agent reading it.\n  // Rewrite any name, description, title, or schema field description that\n  // instructs the agent (which tool to prefer, what to output, rules to\n  // ignore) so it states what the tool does and what it returns instead.\n  description: "Searches the catalog and returns matching items with prices."\n}`;
    case "untrusted-content-hint":
      return `{ name: "${name}", annotations: { untrustedContentHint: true } }`;
    case "human-parity":
      return `// Make the tool's effect visible on the page the person is looking at:\n// update the same UI your existing human flow uses when ${name.toLowerCase().replace(/\s+/g, "_")} runs,\n// so the person co-browsing sees what the agent just did.\nexecute: async (args, { signal }) => {\n  const result = await performAction(args, signal);\n  renderResultInPage(result); // the human-visible half of the same action\n  return result;\n}`;
    case "registration-errors":
      return `document.modelContext.registerTool({ /* ... */ }).catch(function (err) {\n  console.error("WebMCP registration failed", err);\n});`;
    case "tool-selection":
    case "coverage-vs-site-type":
    case "page-experience":
      return null;
    default: {
      const _exhaustive: never = checkId;
      return _exhaustive;
    }
  }
}
