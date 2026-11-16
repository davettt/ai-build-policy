# Samples

These are the scripts and config files the guide refers to. Each one is a sample of how I do something, written to stand on its own: read it, then adapt it to your project. None of them needs anything else from this repo, and they are not a system to install. Chapter 9 gives the order I'd add them in.

| File | What it does | Guide |
|---|---|---|
| `pre-commit` | Git hook: secret scan of the staged files, then lint and format. Fails if no secret scanner is installed | 1.1, 9.2 |
| `gates.js` | Runs your checks in order, stops at the first failure, writes a marker with a hash of the source | 3.2, 9.3 |
| `verify-marker.js` | Called from `pre-commit`: refuses a commit of source files that don't match the marker | 3.2, 9.3 |
| `stop-hook-changelog.js` | Claude Code Stop hook: won't let the assistant finish a turn with changed source and no changelog entry | 1.1, 9.4 |
| `pretool-hook-clean-build.js` | Claude Code PreToolUse hook: refuses a release build while there are uncommitted changes | 6.1, 9.4 |
| `claude-settings.example.json` | The `.claude/settings.json` lines that turn the two hooks on | 9.4 |
| `bootstrap-allowlist.js` | Builds a first `allowed-packages.json` from the packages a project already has | 4.1, 9.5 |
| `check-allowlist.js` | The allowlist gate: unknown packages, entries past their re-check date, missing scores | 4.1, 9.5 |
| `verify-package.js` | Looks a package up on npm and takes one Socket score before it goes on the list | 4.2, 9.5 |
| `dependabot.yml` | Dependabot with a 7-day cooldown, majors left to me, Electron packages grouped | 4.3, 4.4 |
| `ci.yml` | The gates again in GitHub Actions on every push, with secret scanning | 3.2 |
| `smoke-prod.config.mjs`, `smoke-prod.spec.mjs`, `smoke-prod.yml` | A read-only smoke test against the live site after each deploy | 3.2 |
| `banned-patterns.js` | Scans a repo for email addresses, home-directory paths and key shapes | 5.1 |
| `electron-main.js` | Electron main process: loopback-only server, OS-assigned port, navigation guards | 6.3 |
| `entitlements.mac.plist` | The entitlements for a signed, hardened Electron app | 6.2 |
| `notarize-dmg.cjs` | electron-builder hook that signs, notarises and staples the DMG itself | 6.2 |
| `windows.yml` | Builds and unit-tests the app on Windows in CI, ships nothing | 6.6 |
| `brew.env` | Homebrew settings that check what it installs. Not in the guide, an extra | |

The scripts assume Node 20 or later, git, and a project laid out with `src/`, `server/` or `electron/`. Change the paths and lists at the top of each file to match yours. Values like the signing identity, the notary profile and the site URL are placeholders.
