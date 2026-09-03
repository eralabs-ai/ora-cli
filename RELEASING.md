# Releasing `ax`

Releases are manual, deliberate, and run entirely in CI. Nobody publishes from a
laptop.

## Cutting a release

1. Land your changes on `main` and let [CI](.github/workflows/ci.yml) go green.
2. **Actions → Release → Run workflow**, from the `main` branch.
3. Pick a `version_bump`:
   - `patch` — bug fixes
   - `minor` — new commands or flags, backwards compatible
   - `major` — breaking changes to commands, flags, or output
   - `none` — publish `package.json`'s current version as-is
4. Leave `dry_run` unchecked. Run it.
5. If the release changes the command/flag surface the agent-ready-website
   skill invokes (today: `audit` and the flags its playbook shows), bump the
   pinned `CLI_RANGE` in the main repo's
   `src/lib/mcp/skills-content/agent-ready-website.ts` in the same breath and
   run `npm run skills:gen` there - the skill's `npx ax@<range>` calls
   resolve only the release line the playbook documents, so a range left
   behind quietly routes agents to the API fallback instead of the new CLI.

The workflow lints, typechecks, tests, bumps, builds, smoke-tests the bundled
binary, publishes to npm with provenance, tags the built commit, opens a GitHub
Release with generated notes, and opens a `chore(release): vX.Y.Z` PR that lands
the `package.json` bump on `main`.

**Every release leaves one PR to merge.** The workflow deliberately never pushes
to `main` — see [Why the bump comes as a PR](#why-the-bump-comes-as-a-pr). npm,
the tag, and the GitHub Release all land automatically in the run; only the
one-line `package.json` bump waits on that PR. Merge it (squash) to finish the
release. The version on npm is live regardless of when the PR merges.

Note the tag points at the commit the artifact was **built from** (main's HEAD at
dispatch), not at the bump commit — so `vX.Y.Z` and its `package.json` bump are
one commit apart. This is intentional: the repo squash-merges, which rewrites the
bump commit's SHA, so tagging it would orphan the tag.

Rehearse anything uncertain with `dry_run` checked: it does every step including
`npm publish --dry-run`, but publishes nothing, commits nothing, pushes nothing.

## One-time setup

### OIDC Trusted Publishing

Publishing is tokenless: npm verifies the workflow's identity through GitHub's
OIDC provider. The trusted publisher is configured on npmjs.com → `ax` →
**Settings → Trusted Publisher**: GitHub Actions, org `eralabs-ai`, repository
`ora-cli`, workflow `release.yml`, no environment, `npm publish` allowed. The
workflow's `id-token: write` permission plus npm ≥ 11.5.1 (the job upgrades
npm explicitly — Node 22 bundles npm 10, which silently skips the OIDC
exchange) are the only other requirements.

If you ever add an `environment:` to the release job (see hardening below),
update the trusted publisher's environment name to match in the same breath —
they must agree or publishes are rejected.

If tokenless publishing is ever broken and a release can't wait, the fallback
is a **granular access token** with read+write on the `ax` **package** — `ax`
is unscoped, so a token limited to the `@ora-ai` scope does *not* cover it —
stored as `NPM_TOKEN` and passed as `NODE_AUTH_TOKEN` in the publish step.
Prefer fixing OIDC.

### npm org

`ax` is unscoped but org-administered: scope and ownership are independent on
npm. The package's owners are the `ora-ai` org maintainers, and the
`ora-ai:developers` team holds a read-write grant
(`npm access grant read-write ora-ai:developers ax`), so org members publish to
it exactly as they do to `@ora-ai/*` packages. The token's account needs that
access.

## The rename from `@ora-ai/ax`

Versions ≤ `0.5.3` shipped as `@ora-ai/ax`; the plain `ax` name was acquired in
August 2026 and everything from the first `ax` release onward ships there. Two
consequences:

- `ax@0.0.1`–`0.2.2` predate us — an unrelated 2011 logging library that came
  with the name. All are deprecated and must never be reused; every release must
  version above them (the `0.5.x` line already does).
- `@ora-ai/ax` stays published but deprecated, its message pointing here. Don't
  publish to it again.

## When something goes wrong

The workflow publishes to npm **before** it tags or opens the bump PR, on
purpose: npm versions are immutable and effectively permanent, while a tag and a
branch cost nothing to throw away. That shapes recovery:

**Failed before or during publish** — nothing reached npm and nothing was tagged.
Fix the cause and re-run. The bump lived only in the runner's working copy.

**Published, but tagging or the PR step failed** — npm has the release; the tag,
the GitHub Release, or the bump PR is missing. Nothing here is destructive to
redo, and none of it touches `main` directly. Finish by hand — do only the parts
that are actually missing (check `git ls-remote --tags origin`, `gh release
list`, and `gh pr list`):

```sh
V=<the-published-version>   # e.g. 0.7.2

# 1. Tag the commit the artifact was built from (main's HEAD at release time —
#    usually current main if it hasn't moved) and the GitHub Release.
git fetch origin
git tag -a "v$V" -m "Release v$V" origin/main   # pick the real build SHA if main moved
git push origin "v$V"
gh release create "v$V" --title "v$V" --generate-notes --verify-tag

# 2. Land the package.json bump via a PR — a direct push to protected main is
#    rejected by construction (that is the deadlock this flow exists to avoid).
git checkout -b "chore/release-v$V" origin/main
npm version "$V" --no-git-tag-version
npx biome check --write package.json   # npm version reformats it; Lint fails otherwise
git commit -am "chore(release): v$V"
git push -u origin "chore/release-v$V"
gh pr create --title "chore(release): v$V" --body "Records the v$V release already live on npm."
```

Do **not** re-run the Release workflow to fix a stuck release — the preflight
check will correctly refuse, because that version is already on npm (`403 You
cannot publish over the previously published versions`).

**Wrong version published** — you cannot reuse or overwrite a version. Publish
the fix forward under a new version. `npm deprecate` the bad one with a message
pointing at the replacement.

## After the first tokenless release

Once the first OIDC-published release lands cleanly:

1. Delete the `NPM_TOKEN` repo secret and revoke the token on npmjs.com, if
   either still exists.
2. On npmjs.com → `ax` → **Settings → Publishing access**, switch to *Require
   two-factor authentication and disallow bypass 2fa tokens*. Only do this
   after OIDC is proven — it kills token-based publishing, fallback included.

## Why the bump comes as a PR

`main` is protected: two status checks are required (`ci` and `Conventional
commit title`), and one of them — `Conventional commit title` — only ever runs on
`pull_request`. A commit pushed straight to `main` therefore can **never** satisfy
the ruleset: the required checks run only after the ref updates, which the
protection won't allow until they pass. So a direct push from the release job is
rejected by construction and the release deadlocks after the (immutable) npm
publish. This bit `v0.7.0`, `v0.7.1`, and `v0.7.2`, each reconciled by hand.

The workflow sidesteps it entirely: **tags** carry no protection rule, so the tag
and GitHub Release push straight through; the `package.json` bump lands through a
normal PR that runs the required checks and a human merges. Nothing is ever pushed
to `main` directly.

If you would rather keep everything atomic in one run (tag semantics unchanged,
no leftover PR), the alternative is to give the release job a **bypass** on the
branch rule — add a bypass actor for GitHub Actions in the ruleset, or push with a
GitHub App / PAT that can bypass required checks. That costs a permanent hole in
the branch protection plus a secret to manage; the PR flow above needs neither.

## Optional hardening

Add a protected [environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
named `npm` with required reviewers, and set `environment: npm` on the `release`
job. Publishing then needs a second person to approve the run. Worth doing once
more than one maintainer can dispatch releases.
