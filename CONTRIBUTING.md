# Contributing to pi-agy

Thanks for taking the time to contribute! This document covers the branch
model, tooling, and review expectations. For security reports, see
[SECURITY.md](SECURITY.md).

## Ways to contribute

- **Bug reports** — use the [bug report form](https://github.com/d1pankarmedhi/pi-agy/issues/new?template=bug_report.yml).
- **Feature requests** — use the [feature request form](https://github.com/d1pankarmedhi/pi-agy/issues/new?template=feature_request.yml).
- **Pull requests** — bug fixes, features, docs, and tooling.
- **Questions** — start a [discussion](https://github.com/d1pankarmedhi/pi-agy/discussions).

## Branch model

| Branch      | Purpose                                                            |
| ----------- | ------------------------------------------------------------------ |
| `main`      | Production. Always releasable. Every commit is a tagged release or a hotfix. |
| `develop`   | Integration. The default target for pull requests.                  |
| `feature/*` | New work, branched from `develop`, merged back into `develop`.      |
| `fix/*`     | Non-urgent fixes, branched from `develop`.                          |
| `release/*` | Release prep (version + changelog), branched from `develop`.        |
| `hotfix/*`  | Urgent production fixes, branched from `main`.                      |

Rules:

- **Open pull requests against `develop`**, never directly against `main`.
  The only exceptions are release PRs (`develop` → `main`) and hotfixes, opened
  by a maintainer.
- Keep `main` linear and releasable. Enable branch protection on `main`
  (require the `CI` checks and at least one review) and on `develop` (require
  the `CI` checks) in repository settings.
- After a release or hotfix is merged to `main`, back-merge `main` into
  `develop` so integration never drifts behind production.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`. Examples from this repository: `feat(tui): …`,
`feat(vision): …`, `chore: expand .gitignore`.

- Write the summary in the imperative mood, lower-case, no trailing period.
- Add a body explaining **why**, not just what, for non-trivial changes.
- Reference issues with `Closes #123` in the body or PR description.

## Development setup

Requirements: **Node.js >= 22.18** (type-stripped `.ts` tests) and npm.

```bash
git clone https://github.com/d1pankarmedhi/pi-agy.git
cd pi-agy
npm install
npm run typecheck    # tsc --noEmit
npm test             # node --test tests/*.test.ts
npm run pack:check   # inspect the exact npm tarball contents
```

Load your working copy into pi for manual testing:

```bash
pi -e /absolute/path/to/pi-agy      # temporary, this run only
# or
pi install /absolute/path/to/pi-agy # persistent
pi remove /absolute/path/to/pi-agy
```

`agy` must be installed and authenticated (`agy -p "hi"` works in a terminal).
`/agy-doctor` in pi prints a setup report.

## Project layout

`index.ts` wires the extension; all logic lives in `src/` with one-directional
dependencies. See the [Development section of the README](README.md#development)
for the module map. Keep new behavior in `src/` with unit tests under `tests/`.

## Tests

- Every behavior change needs a test, or an explanation of why one is not
  practical (e.g. pure TUI rendering verified manually).
- Tests use the built-in `node:test` runner with no extra dependencies; keep
  dependencies injected/pure where possible.
- Run the full suite before opening a PR. CI runs it on Node 22, 24, and 26.

## Pull request process

1. Fork (or branch) from `develop`.
2. Make focused commits; keep refactors separate from behavior changes.
3. Update `README.md` and, for user-visible changes, `CHANGELOG.md` under
   `[Unreleased]` using [Keep a Changelog](https://keepachangelog.com/) headings
   (`Added`, `Changed`, `Fixed`, `Removed`, `Security`).
4. Ensure `npm run typecheck`, `npm test`, and `npm run pack:check` pass.
5. Open the PR against `develop` and fill in the template.
6. CI must be green and review resolved before merge. Squash-merge by default so
   `develop` reads as a series of Conventional Commits.

## Release process

See [RELEASING.md](RELEASING.md). Releases are cut from `main`, tagged
`vX.Y.Z`, published to npm by the `Release` workflow, and accompanied by a
GitHub Release. Versions follow [Semantic Versioning](https://semver.org/).

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
