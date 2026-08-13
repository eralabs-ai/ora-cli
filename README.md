# ax — the ora CLI

Score any site's agent readiness — and watch real AI agents navigate it. Powered by [ora](https://ora.ai)'s hosted APIs.

```
npx @ora-ai/ax audit https://stripe.com
```

Three commands:

- **`audit <url>`** — run ora's hosted agent-readiness audit against a site: live progress, then a layered report of what passed, what's broken, and ora's ranked list of the highest-impact fixes (or `--json` for the raw contract payload). No account or API key needed. Gate CI with `--min-score`.
- **`journey "<intent>"`** — send a real AI agent (claude-code, codex, …) at a site and watch its navigation live as a boxed node-graph, then get the scored insight, tokens, and cost. Requires an `ORA_API_KEY`.
- **`skill [name]`** — list, print, or install ora's agent skills, digest-verified from the public registry.

## audit

```
ax audit <url> [--min-score n] [--max-age s] [--force] [--tunnel-cmd c] [--json] [--show-passing] [--show-skipped]
```

```
  stripe.com  78/100 B+
  Stripe offers strong developer resource discoverability, but lacks an OpenAPI specification.

  Discovery   ██████░░░░ 6/9 passed · 1 skipped
    ✗ Issues (3)
    ┌───┬──────────────┬───────────────────────────┬──────────────────────────────┐
    │   │ Check        │ What's wrong              │ How to fix                   │
    ├───┼──────────────┼───────────────────────────┼──────────────────────────────┤
    │ ✗ │ sitemap.md   │ status 404                │ Publish /sitemap.md listing… │
    ├───┼──────────────┼───────────────────────────┼──────────────────────────────┤
    │ ⚠ │ robots.txt   │ partially restricted      │ Allow AI crawlers in robots… │
    └───┴──────────────┴───────────────────────────┴──────────────────────────────┘

  Top fixes (ranked by ora)
  1. sitemap-md   ≈ +4 pts
  2. robots-txt   ≈ +1.2 pts

  cached result (43 min old) · pass --force for a fresh scan
  Full report: https://ora.ai/stripe.com
```

| Flag | Effect |
|---|---|
| `--min-score <n>` | Exit `1` when the score is below `n` (0-100) — the CI gate |
| `--max-age <s>` | Accept a cached result up to `s` seconds old (server default 6h, clamped to 1-24h) |
| `--force` | Bypass the cache and rescan — spends the stricter 6/day force budget |
| `--tunnel-cmd <c>` | Expose a local target through your own tunnel command and audit the public URL it prints (also read from `ORA_TUNNEL_CMD`) |
| `--json` | The raw ora audit payload on stdout, exactly as the API served it |
| `--show-passing` | List every passing check, not just the per-layer summary bar |
| `--show-skipped` | Include not-applicable/pending checks with their reason |

The **Top fixes** list is ranked by ora server-side (non-bonus fixes first, then estimated score uplift) — the CLI renders it verbatim. All `≈ +N pts` figures are estimates. Check *tiers* (required / recommended / emerging) are advisory display metadata and never determine the score.

### CI gate

```yaml
- name: Agent-readiness gate
  run: npx @ora-ai/ax audit https://your-site.com --min-score 70
```

Exit codes are the contract:

| Code | Meaning |
|---|---|
| `0` | success (and score ≥ `--min-score` when given) |
| `1` | score below `--min-score` |
| `2` | usage error — bad flags, malformed URL, local target without a tunnel |
| `3` | API unreachable, timeout, or rate limit exhausted |

Budget notes: ora allows 30 scans + 6 `--force` scans per rolling 24h per IP (plus a 10/min burst limit). Results served from the freshness cache cost nothing, so a CI job that audits on every push stays well inside the budget — tune the window with `--max-age`, and reserve `--force` for verifying a fix you just deployed. An auth-gated MCP target reports `mcpAuthRequired` and scores 0 as "could not evaluate"; `--min-score` deliberately skips the gate rather than failing on it.

### Auditing localhost (`--tunnel-cmd`)

A local dev server only exists on your machine, so ora can't reach it. The simplest option is to audit a publicly reachable deployment of the same code (e.g. a preview URL). To audit localhost itself, bring your own tunnel: pass `--tunnel-cmd` (or set `ORA_TUNNEL_CMD`) with a command that exposes the local server and prints its public `https://` URL. The CLI runs it, audits the URL it prints, and tears the tunnel down when done.

```
ax audit localhost:3000 --tunnel-cmd 'ngrok http 3000 --log stdout'
```

- **The CLI ships no tunnel vendor and never downloads executables at runtime** — any tunnel tool you already have works, as long as it prints its public URL to stdout or stderr.
- The result is stored as **ephemeral**: excluded from ora's rankings and deleted after a few days.
- Off-site checks (registry listings, brand search) usually fail for a throwaway tunnel hostname — the report says so. Use tunnel audits to iterate on your on-site surface, not to compare scores.
- Free tiers of some tunnel vendors serve an interstitial warning page to browser-like requests, which can distort what the scanner sees — prefer a vendor/plan that serves your origin directly.

## skill

```
ax skill                                # list the registry
ax skill agent-ready-website            # print a SKILL.md
ax skill agent-ready-website --install  # write .claude/skills/<name>/SKILL.md
```

Skills come from ora's public registry (`https://ora.ai/.well-known/agent-skills/`) and every byte is verified against the registry's sha256 digest before it is printed or installed. Skill content is never bundled into this package. `--dir <path>` overrides the install directory.

## journey

```
ax journey "<intent>" [--domain d] [--harness h] [--model m] [--json]
```

```
ax journey "Find the API docs and how to authenticate" --domain stripe.com
```

Triggers a real agent run on ora's platform and renders the journey live — the whole graph repaints in place as the agent moves:

```
  ▶ stripe.com  ·  claude-code

  9 steps  ·  3 reasoning  ·  1 search

  ╭────────────────────────────────────────────────────────────────────────────────╮
  │ ◆ Find the API docs and how to authenticate. Fetch the actual pages to verify. │
  ╰─┬──────────────────────────────────────────────────────────────────────────────╯
    │  (…) The user is asking me to find the API documentation for Stripe…
    │  ╭──────────────────────────────────────────────╮
    ╰──┤ 🔍 "Stripe API documentation authentication" │
       ╰─┬────────────────────────────────────────────╯
         │  ╭─────────────────────────────────────────╮
         ├──┤ 🌐 docs.stripe.com/api/authentication ✓ │
         │  ╰─────────────────────────────────────────╯
         │  ╭───────────────────────────╮
         ╰──┤ 🌐 docs.stripe.com/apis ✓ │
            ╰───────────────────────────╯

  ────────────────────────────────────────────────────
  ✓ completed  9 turns · 30.8s · 119.1k tokens · $0.031

  Visibility  █████████████████████░ 95/100   ✓ intent satisfied
```

Edges come from ora's own per-step attribution (link-follows nest under the page that linked them; searches hang off the intent). `(…)` markers are the agent's reasoning, placed above the action it led to.

| Flag | Effect |
|---|---|
| `--domain <d>` | Site the agent targets (e.g. `stripe.com`) |
| `--harness <h>` | Agent harness: `claude-code` (default), `codex`, `openclaw`, `hermess`, `claude-agent`, `eve`, … |
| `--model <m>` | Model override (e.g. `claude-haiku-4-5-20251001` — cheap and good for demos) |
| `--json` | Full result as JSON: run metadata, usage, insight, and the raw trajectory |

Note: run-to-run variance is real — agents sometimes answer from search snippets without fetching, which scores differently. Run a few journeys before drawing conclusions.

Journey exit codes: `0` run outcome `success` · `1` non-success outcome · `2` any error.

### Setup

`journey` needs an ora platform API key (scopes `runs:read` + `runs:write`):

```sh
export ORA_API_KEY=ora_sk_...        # your shell, CI secret store, etc.
ax journey "Find the pricing page" --domain example.com
```

For local development, copy `.env.example` to `.env` — the CLI reads a `.env` in the working directory on startup (exported variables win over the file).

## Library use

The same contract-typed client the CLI uses is importable:

```ts
import { audit } from "@ora-ai/ax";

const { result } = await audit("stripe.com");
console.log(result.score, result.grade, result.topFixes);
```

`result` is the raw versioned audit payload (`AuditScanResult` / `AuditScoreResult`, generated from ora's OpenAPI spec). `fetchSkill` / `fetchSkillIndex` expose the digest-verified skill registry.

## Environment variables

All configuration is environment-first: the consumer defines the variables, the CLI only reads them.

A `.env` in the working directory is read on startup — copy `.env.example` and fill it in. Anything already exported wins over the file, so a key set for your shell or by CI beats a stale `.env`.

| Var | Used by | Default | Purpose |
|---|---|---|---|
| `ORA_API_URL` | audit, skill | `https://ora.ai` | Public API base (no auth) |
| `ORA_PLATFORM_URL` | journey | `https://api.agentfront.sh` | Authenticated platform API base |
| `ORA_API_KEY` | journey | — (required) | Secret key (`ora_sk_…`), exchanged for a short-lived bearer token |

## Contract versioning

The audit types are generated from ora's served OpenAPI spec (`pnpm contract:gen`); the build is pinned to a contract version and CI fails when production drifts from the checked-in types. At runtime, the CLI prints one stderr warning when ora reports a newer contract than the build — upgrade with `npm i -g @ora-ai/ax@latest`.

## Migrating from 0.1.x

- `ax scan` is now `ax audit` (no alias).
- `--json` prints the raw ora audit payload instead of the old reshaped envelope: stable check ids, layer ids, `grade`, `topFixes`, and `contractVersion` — key your scripts to those fields.
- Audit API failures now exit `3` (usage errors stay `2`).

## Development

```sh
pnpm install
pnpm test            # vitest (watch)
pnpm test:ci         # single run + coverage
pnpm typecheck
pnpm lint
pnpm contract:gen    # regenerate src/contract/ from the served OpenAPI spec
pnpm build           # tsup → dist/main.cjs (bin) + dist/index.* (library)
pnpm smoke           # run the built binary the way a user would (needs build)
pnpm verify:pack     # check the tarball npm would publish (needs build)
node dist/main.cjs audit https://example.com
```

Manual testing without burning the live scan rate limit:

```sh
node scripts/mock-scan-server.mjs &
ORA_API_URL=http://localhost:8799 node dist/main.cjs audit https://example.com
```

To exercise the published-package experience locally: `npm pack`, then `npx ./ora-ai-ax-0.2.0.tgz audit https://example.com`, or `pnpm link --global` and use `ax` directly.

## Releasing

Publishing runs from GitHub Actions only — **Actions → Release → Run workflow**,
pick a `patch`/`minor`/`major` bump. See [RELEASING.md](RELEASING.md) for the
runbook, required setup, and failure recovery.

## License

MIT
