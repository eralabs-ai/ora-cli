# Releasing `@ora-ai/ax`

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

The workflow lints, typechecks, tests, bumps, builds, smoke-tests the bundled
binary, publishes to npm with provenance, then commits `chore(release): vX.Y.Z`,
tags it, and opens a GitHub Release with generated notes.

Rehearse anything uncertain with `dry_run` checked: it does every step including
`npm publish --dry-run`, but publishes nothing, commits nothing, pushes nothing.

## One-time setup

### `NPM_TOKEN`

Create a **granular access token** on npmjs.com with read+write on the `@ora-ai`
scope, then:

```sh
gh secret set NPM_TOKEN --repo eralabs-ai/ora-cli
```

Granular tokens bypass 2FA prompts, which is what makes automated publishing
work. Give it an expiry and diarise the rotation.

### npm org

The `@ora-ai` scope must exist on npmjs.com and the token's account needs publish
rights on it. The scope is unclaimed as of the first release — claim it before
someone else does.

## The first release

`package.json` is at `0.1.0` and nothing is published yet. Any bump would skip
`0.1.0` and make `0.1.1` your first version. To ship `0.1.0` itself, run the
workflow with **`version_bump: none`**.

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

## Migrating to OIDC Trusted Publishing

Trusted Publishing removes the long-lived `NPM_TOKEN` entirely: npm verifies the
workflow's identity through GitHub's OIDC provider instead of a stored
credential. It requires the package to already exist, which is why the first
release uses a token.

Once `@ora-ai/ax` is published:

1. npmjs.com → the package → **Settings → Trusted Publisher** → GitHub Actions.
   Set repository `eralabs-ai/ora-cli` and workflow `release.yml`.
2. In [`.github/workflows/release.yml`](.github/workflows/release.yml), delete
   the `NODE_AUTH_TOKEN` line from the *Publish to npm* step (and the comment
   above it). Everything else already works — the job holds `id-token: write`
   and publishes with `--provenance`.
3. Verify with a `dry_run`, then cut a real patch release.
4. Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com.

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
