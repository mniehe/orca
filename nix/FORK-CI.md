# Personal fork CI policy

This fork retains upstream PR checks, Mobile Checks, dependency security, main
blocking-work guards, and their reusable workflow dependencies. Expensive tests
remain available through their retained PR, manual or reusable entry points.

## Fork-local workflow settings

The following workflows are disabled in `mniehe/orca` through GitHub Actions
settings, not deleted from source. These settings do not affect upstream and are
not reproduced by cloning the repository.

### Publishing, signing and release orchestration

- `adhoc-mac-build.yml`
- `agent-state-rules-publish.yml`
- `daily-mac-build.yml`
- `dev-channel-win-build.yml`
- `dev-channel-win-publish.yml`
- `homebrew-bump.yml`
- `hourly-mac-build.yml`
- `mobile-android-release.yml`
- `mobile-ios-release.yml`
- `readme-downloads-badge.yml`
- `release-cut.yml`
- `release-javascript.yml`
- `release-mac-build.yml`
- `release-mirror-r2.yml`
- `release-policy.yml`
- `windows-signing-rehearsal.yml`

### Cache maintenance and capacity reporting

- `ci-branch-cache-sweep.yml`
- `ci-cache-warmup-platform-jobs.yml`
- `ci-cache-warmup-platforms.yml`
- `ci-cache-warmup.yml`
- `ci-closed-pr-caches.yml`
- `ci-runner-demand.yml`
- `ci-xterm-cache.yml`
- `unit-module-cache.yml`

### Benchmarks and optional automation

- `computer-task-benchmark.yml`
- `issue-os-labeler.yaml`
- `pr-test-loc.yml`
- `preflight-benchmark.yml`
- `preflight-critical-path-benchmark.yml`
- `pullfrog.yml`
- `release-javascript-benchmark.yml`
- `unit-module-cache-benchmark.yml`
- `windows-native-preparation-benchmark.yml`
- `wsl-orcad-e2e-frozen-runner-retry.yml`

## Retained workflows without schedules

Only their `schedule` triggers are removed; jobs, permissions, inputs and other
triggers remain unchanged:

- `computer-e2e.yml`
- `computer-macos-native.yml`
- `e2e.yml`
- `node-next-compat.yml`
- `node-server-tests.yml`
- `orca-server-artifact.yml`
- `packaged-browser-e2e.yml`
- `performance-contracts.yml`
- `terminal-ime-e2e.yml`
- `wsl-orcad-e2e.yml`

Do not disable a reusable workflow while an enabled workflow still calls it.
In particular, PR Checks calls the unit workflows, E2E, terminal IME and Windows
WSL checks. Do not provision upstream publishing credentials or custom runners
merely to make an inherited maintenance or release workflow pass.

After syncing upstream, review new workflow files (both `.yml` and `.yaml`),
reintroduced schedules, and reusable callers before pushing. GitHub workflow
settings can be inspected with `gh workflow list --all --repo mniehe/orca` and
changed with `gh workflow disable <filename> --repo mniehe/orca`. Read back the
settings after changes. An enabled workflow is not evidence that its jobs ran or
passed.

The inherited checks do not establish that the Nix desktop package builds or
launches. Fork-specific Nix CI remains a separate follow-up.
