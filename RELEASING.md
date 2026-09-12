# Releasing pi-agy

This is the maintainer runbook for cutting a release. It follows the standard
open-source flow: version and changelog on `develop`, merge to the production
branch `main`, tag, then let CI publish.

- **Package name on npm:** `pi-agy-cli`. The bare name `pi-agy` is already
  taken by an unrelated project, so the repository/brand stays `pi-agy` while
  the published artifact is `pi-agy-cli`. Users install it with
  `pi install npm:pi-agy-cli`.
- **Versioning:** [Semantic Versioning](https://semver.org/).
- **Changelog:** [Keep a Changelog](https://keepachangelog.com/), newest first.
- **Tags:** annotated `vX.Y.Z` (e.g. `v0.3.0`), created on `main`.

## One-time repository setup

Do these once, before the first release.

1. **Create the `develop` branch** if it does not exist:

   ```bash
   git checkout main
   git pull
   git checkout -b develop
   git push -u origin develop
   ```

2. **Protect the branches** (Settings → Branches):
   - `main`: require a pull request, require the `CI` status checks, require
     at least one approval, and disallow force-pushes.
   - `develop`: require the `CI` status checks and disallow force-pushes.

3. **Enable private vulnerability reporting and CodeQL** (Settings → Code
   security). The `CodeQL` workflow also runs on a schedule.

4. **Choose npm authentication** (see the next section).

## npm authentication

The `Release` workflow supports two modes. **Trusted Publishing (OIDC) is
preferred** — there is no long-lived secret to rotate or leak.

### Option A — npm Trusted Publishing (recommended)

The workflow already requests the `id-token: write` permission and calls
`npm publish --provenance`.

To finish the setup:

1. On [npmjs.com](https://www.npmjs.com/), open the `pi-agy-cli` package →
   **Settings** → **Trusted Publisher** → **GitHub Actions**.
2. Set:
   - **Organization or user:** `d1pankarmedhi`
   - **Repository:** `pi-agy`
   - **Workflow filename:** `release.yml`
   - **Environment:** leave blank (or add a GitHub Environment and set the same
     name on both sides for an extra approval gate).
3. Ensure no `NPM_TOKEN` repository secret is set — with trusted publishing
   configured, npm authenticates via OIDC automatically.

> **First publish caveat:** npm can only attach a trusted publisher to a package
> that already exists. For the very first release, publish with a token
> (Option B), then configure the trusted publisher and delete the secret.

### Option B — npm access token (bootstrap / fallback)

1. Create a **Granular Access Token** on npm with *Read and write* permission
   for the `pi-agy-cli` package (or a classic *Automation* token). Prefer
   limiting it to this package.
2. Add it as a repository secret named **`NPM_TOKEN`**
   (Settings → Secrets and variables → Actions → New repository secret).
3. The workflow passes it as `NODE_AUTH_TOKEN`. `--provenance` still works and
   attaches a signed attestation.

To rotate later, replace the secret value. To switch to OIDC, configure the
trusted publisher and delete the secret.

## Release checklist

1. **Sync and branch** from up-to-date `develop`:

   ```bash
   git checkout develop
   git pull
   git checkout -b release/0.3.0
   ```

2. **Bump the version.** The `preversion` script runs `release:verify`
   (typecheck + tests + tarball check) before the bump, and `npm version`
   updates `package.json` and `package-lock.json`:

   ```bash
   npm version 0.3.0 --no-git-tag-version
   ```

3. **Update `CHANGELOG.md`**: move everything under `[Unreleased]` into a new
   `## [0.3.0] - YYYY-MM-DD` section, and add fresh comparison links at the
   bottom if the file uses them. Leave an empty `[Unreleased]` section on top.

4. **Open the release PR** `release/0.3.0` → `develop`, get it merged.

5. **Promote to production**: open a PR `develop` → `main` (titled
   `release: 0.3.0`). This is the only kind of PR that targets `main`.

6. **Tag `main` and push the tag** — this is what triggers the release:

   ```bash
   git checkout main
   git pull
   git tag -a v0.3.0 -m "pi-agy-cli 0.3.0"
   git push origin v0.3.0
   ```

7. **Watch the `Release` workflow.** It:
   - fails if the tag does not match `package.json`'s version,
   - runs typecheck + tests,
   - publishes to npm with provenance,
   - creates the GitHub Release (prerelease for `-beta`/`-rc` tags).

8. **Back-merge** so `develop` never lags behind production:

   ```bash
   git checkout develop
   git merge --no-ff main
   git push origin develop
   ```

9. **Verify** `pi install npm:pi-agy-cli@0.3.0` works and that the GitHub
   Release lists the tag.

## Prereleases

Use a prerelease suffix (`v0.3.0-beta.1`, `v0.3.0-rc.1`). The `Release` workflow
derives the npm dist-tag from the suffix (`beta`, `rc`, …) so a prerelease is
never published to `latest`, and marks the GitHub Release as a prerelease.
Testers install it explicitly:

```bash
pi install npm:pi-agy-cli@0.3.0-beta.1
```

## Hotfixes

For a critical fix in production:

1. Branch `hotfix/x.y.z` from `main`.
2. Fix, test, update `CHANGELOG.md`, and bump the patch version.
3. Open a PR to `main` (a maintainer merges it).
4. Tag `main` as above; the `Release` workflow publishes.
5. Back-merge `main` into `develop`.

## Manual / emergency publish

If CI is unavailable, a maintainer can publish locally. Provenance is only
generated in CI, so document why the fallback was used in the GitHub Release.

```bash
npm login
npm run release:verify
npm publish --access public
```
