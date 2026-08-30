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
binary, publishes to npm with provenance, then commits `chore(release): vX.Y.Z`,
tags it, and opens a GitHub Release with generated notes.

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

The workflow publishes to npm **before** it pushes to git, on purpose: npm
versions are immutable and effectively permanent, while a local commit and tag
cost nothing to throw away. That shapes recovery:

**Failed before or during publish** — nothing was pushed and nothing reached npm.
Fix the cause and re-run. The bump lived only in the runner's working copy.

**Published, but the push failed** — npm has the release and git does not. This
usually means `main` moved between checkout and push. Reconcile by hand:

```sh
git checkout main && git pull
npm version <the-published-version> --no-git-tag-version
git commit -am "chore(release): v<the-published-version>"
git tag -a "v<the-published-version>" -m "Release v<the-published-version>"
git push origin main --follow-tags
gh release create "v<the-published-version>" --generate-notes --verify-tag
```

Do **not** re-run the Release workflow to fix this — the preflight check will
correctly refuse, because that version is already on npm.

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

## If you protect `main`

The release job pushes its bump commit and tag directly to `main` using the
built-in `GITHUB_TOKEN`. `main` is currently unprotected, so this works as-is.
If you add branch protection, that push starts failing — grant the exception via
a bypass allowance for GitHub Actions in the ruleset, or swap the checkout token
for a PAT that can bypass it.

## Optional hardening

Add a protected [environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
named `npm` with required reviewers, and set `environment: npm` on the `release`
job. Publishing then needs a second person to approve the run. Worth doing once
more than one maintainer can dispatch releases.
