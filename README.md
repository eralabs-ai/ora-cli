# ax — the ora CLI

Score any site's agent readiness — and watch real AI agents navigate it. Powered by [ora](https://ora.ai)'s hosted APIs.

```
npx @ora-ai/ax audit https://stripe.com
```

Two commands:

- **`audit <url>`** — run ora's hosted agent-readiness scan against a site: live progress, then a layered report of what passed, what's broken, and exactly how to fix it (or `--json`). No account or API key needed.
- **`journey "<intent>"`** — send a real AI agent (claude-code, codex, …) at a site and watch its navigation live as a boxed node-graph, then get the scored insight, tokens, and cost. Requires an `ORA_API_KEY`.

## audit

```
ax audit <url> [--json] [--min-score n] [--show-passing] [--show-skipped]
```

```
  https://stripe.com  71/100 Good
  Stripe offers strong developer resource discoverability, but lacks an OpenAPI specification.

  Discovery   ██████░░░░ 6/9 passed · 1 skipped
    ✗ Issues (3 · +4 pts)
    ┌───┬──────────────┬───────────────────────────┬──────────────────────────────┐
    │   │ Check        │ What's wrong              │ How to fix                   │
    ├───┼──────────────┼───────────────────────────┼──────────────────────────────┤
    │ ✗ │ sitemap.md   │ status 404                │ Publish /sitemap.md listing… │
    ├───┼──────────────┼───────────────────────────┼──────────────────────────────┤
    │ ⚠ │ robots.txt   │ partially restricted      │ Allow AI crawlers in robots… │
    └───┴──────────────┴───────────────────────────┴──────────────────────────────┘

  Run with --show-passing to list all 18 passing checks
  2 checks skipped — run with --show-skipped to see them
```

| Flag | Effect |
|---|---|
| `--json` | Full machine-readable result on stdout (every check, all layers), nothing else |
| `--min-score <n>` | Exit `1` if the score is below `n` (for CI gates) |
| `--show-passing` | List every passing check, not just the per-layer summary bar |
| `--show-skipped` | Include not-applicable/pending checks with their reason |

Issues are ordered by estimated score gain — the top row is the highest-impact fix. The public scan API is rate limited to ~10 scans/min per IP.

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
| `--harness <h>` | Agent harness: `claude-code` (default), `codex`, `aider`, `openai-web`, `claude-web`, `tavily` |
| `--model <m>` | Model override (e.g. `claude-haiku-4-5-20251001` — cheap and good for demos) |
| `--json` | Full result as JSON: run metadata, usage, insight, and the raw trajectory |

Note: run-to-run variance is real — agents sometimes answer from search snippets without fetching, which scores differently. Run a few journeys before drawing conclusions.

### Setup

`journey` needs an ora platform API key (scopes `runs:read` + `runs:write`). The CLI reads plain environment variables — nothing is loaded implicitly:

```sh
export ORA_API_KEY=ora_sk_...        # your shell, CI secret store, etc.
ax journey "Find the pricing page" --domain example.com
```

For local development, copy `.env.example` to `.env` and let Node inject it:

```sh
node --env-file=.env dist/main.cjs journey "Find the pricing page" --domain example.com
```

## Environment variables

All configuration is environment-first: the consumer defines the variables, the CLI only reads them.

| Var | Used by | Default | Purpose |
|---|---|---|---|
| `ORA_API_URL` | audit | `https://ora.ai` | Public scan API base (no auth) |
| `ORA_PLATFORM_URL` | journey | `https://api.staging.agentfront.sh` | Authenticated platform API base |
| `ORA_API_KEY` | journey | — (required) | Secret key (`ora_sk_…`), exchanged for a short-lived bearer token |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | audit: scan ok (and ≥ `--min-score` if set) · journey: run outcome `success` |
| `1` | audit: score below `--min-score` · journey: run finished with a non-success outcome |
| `2` | any error (bad flag value, API failure, timeout) |

## Development

```sh
pnpm install
pnpm test            # vitest (watch)
pnpm test:ci         # single run + coverage
pnpm typecheck
pnpm lint
pnpm build           # tsup → dist/main.cjs (single self-contained binary)
node dist/main.cjs audit https://example.com
```

Manual testing without burning the live scan rate limit:

```sh
node scripts/mock-scan-server.mjs &
ORA_API_URL=http://localhost:8799 node dist/main.cjs audit https://stripe.com
```

To exercise the published-package experience locally: `npm pack`, then `npx ./ora-ai-ax-0.1.0.tgz audit https://example.com`, or `pnpm link --global` and use `ax` directly.

## License

MIT
