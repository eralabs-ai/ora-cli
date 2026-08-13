import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestOf, fetchSkill, fetchSkillIndex, SkillApiError } from "./skills";

// Index shape mirrors ora's real /.well-known/agent-skills/index.json
// (agentskills.io discovery 0.2.0): name, type, description, url, digest.
const SKILL_BYTES = new TextEncoder().encode("---\nname: agent-ready-website\n---\n\n# Skill\n");
const DIGEST = `sha256:${createHash("sha256").update(SKILL_BYTES).digest("hex")}`;

const INDEX = {
	$schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
	skills: [
		{
			name: "agent-ready-website",
			type: "skill-md",
			description: "Build or improve websites to be agent-ready.",
			url: "/.well-known/agent-skills/agent-ready-website/SKILL.md",
			digest: DIGEST,
		},
	],
};

const route = (index: unknown, bytes: Uint8Array) =>
	vi.fn(async (url: string | URL) => {
		if (String(url).endsWith("index.json")) {
			return new Response(JSON.stringify(index), { status: 200 });
		}
		return new Response(bytes, { status: 200 });
	});

describe("skill registry client", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("lists the registry index", async () => {
		vi.stubGlobal("fetch", route(INDEX, SKILL_BYTES));
		const skills = await fetchSkillIndex();
		expect(skills.map((s) => s.name)).toEqual(["agent-ready-website"]);
	});

	it("fetches a skill and verifies its digest", async () => {
		const fetchMock = route(INDEX, SKILL_BYTES);
		vi.stubGlobal("fetch", fetchMock);
		const { entry, bytes } = await fetchSkill("agent-ready-website");
		expect(entry.digest).toBe(DIGEST);
		expect(digestOf(bytes)).toBe(DIGEST);
		// The relative index URL is resolved against the base.
		const skillUrl = String(fetchMock.mock.calls[1][0]);
		expect(skillUrl).toBe("https://ora.ai/.well-known/agent-skills/agent-ready-website/SKILL.md");
	});

	it("refuses bytes whose digest does not match the index", async () => {
		vi.stubGlobal("fetch", route(INDEX, new TextEncoder().encode("tampered content")));
		await expect(fetchSkill("agent-ready-website")).rejects.toThrow(/digest mismatch/);
	});

	it("names the known skills when asked for an unknown one", async () => {
		vi.stubGlobal("fetch", route(INDEX, SKILL_BYTES));
		await expect(fetchSkill("nope")).rejects.toThrow(/unknown skill.*agent-ready-website/);
	});

	it("wraps network failures as SkillApiError", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("getaddrinfo ENOTFOUND");
			}),
		);
		await expect(fetchSkillIndex()).rejects.toThrow(SkillApiError);
	});
});
