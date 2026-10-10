# Build & Development Policy

**Version:** 2.67
**Last updated:** 2026-10-10

Single source of truth for how we build, maintain, and ship software. Every AI assistant (Claude, Codex, or other) and every human developer follows this workflow.

## The enforcement principle

**Every automatable step in this policy is either enforced by a machine or evidenced by an artifact a machine checks. Steps that require human judgment are explicitly named as judgment steps; prose is never the enforcement layer for a rule that can be mechanically checked.** LLMs follow instructions probabilistically; programs execute the same way every time. So the process lives in `scripts/policy.js` and its hooks, and this document describes the control system for the humans working with it. An AI tool doesn't need to memorise this document — it needs to run the commands and respond to what they report.

### Which layer a check belongs in

There are two enforcement layers and they are not interchangeable.

**Claude Code hooks** fire while the AI is working. The AI caused the problem, sees the failure in context, and fixes it before the developer looks at anything. This is where workflow and quality checks belong: CHANGELOG discipline, the gates marker, the build-order guards.

**Git hooks** fire on `git commit`, which is the developer's action — and the developer commits, never the AI. A failure here interrupts the person who did not cause it, and the fix has to go back to the AI regardless. Git hooks are therefore the backstop, not the primary catch, and they carry only what must never land whatever the tool: secrets, private data, unverified code. Every check added here is paid on every commit, forever.

Duplicate a rule across both layers only when the consequence is permanent. The gates marker is the model: the Stop hook blocks the AI from ending its turn without one, and `verify-marker` in pre-commit is the net if that was somehow bypassed.

Agents other than Claude Code get no hooks of the first kind, so for them the git layer is the only automatic enforcement and it arrives late. That is a reason for those agents to run the commands `AGENTS.md` lists, not a reason to move checks into the git layer: doing so delays feedback for every tool, including the ones that were catching problems early.

Claude Code is the fully hooked environment: session-start, stop, and pre-tool controls fire while the agent is working. Other agents use the same policy commands and are held by the same pre-commit and CI backstops, but their early-session behavior depends on `AGENTS.md` compliance unless that tool has equivalent hooks configured.

The single entrypoint (run from any project root; `build-policy/` is a sibling directory):

```bash
node ../build-policy/scripts/policy.js <command>
```

| Command | What it does | When it runs |
|---|---|---|
| `setup-machine` | Installs per-machine wiring (hook script, hooks, agents) from `machine/` | New machine, once |
| `doctor` | Machine setup checks: tools, npmrc, hooks, agents, notary profile | New machine; troubleshooting |
| `check` | Project compliance: required scripts/files/configs, template drift, staleness. `--all` runs it for every project beside build-policy and prints one table | **Automatically at every session start** (Claude hook); after fixing gaps; `--all` to see the portfolio backlog |
| `scaffold` | Creates missing standard files and scripts; never overwrites | New projects; fixing `check` gaps |
| `sync-templates` | Overwrites the drift-checked files (ci.yml, dependabot.yml, pre-commit, AGENTS.md, .nvmrc) from the templates and resets the two secret-scan scripts to the standard, one project per run. Not a destructive action: it is the sanctioned fix, gated like any change | When `check` reports template drift or a drifted secret-scan script |
| `gates` | Runs all quality gates in order; writes a diff-hashed pass marker | Before presenting any work (`/gates`); `--fast` subset on every commit (husky) |
| `verify-marker` | Pre-commit: refuses a commit of source or dependency files without a full-gates marker for the exact tree | Every commit (husky), never by hand |
| `verify-ready` | Marker matches current diff + CHANGELOG updated + smoke coverage + security review recorded; records a pass the DMG build requires | Before declaring work ready; `--release` before shipping |
| `security-ack` | Records that `/security-review` ran, bound to the content it examined | After reviewing a change touching auth, secrets, crypto, CORS, payment or data deletion; in build-policy, after any change to `scripts/`, `machine/` or `templates/` |
| `health` | npm outdated/audit, registry staleness; records run timestamp | When `check` flags maintenance overdue (>30 days) |
| `upgrade <pkg>` | Grounds a major dependency upgrade in npm facts (real peer constraints, migration source); scaffolds a decision record | Before any major version bump; `check`/`verify-ready` FAIL without the record |
| `deps-update` | Refreshes dependencies inside their declared ranges (minor/patch); majors untouched | When `check` reports drift; before starting feature work |
| `approve-exception <GHSA-id>` | Prints the drafted advisory exception as prose for the developer to read; `--confirm` then records the approval, bound to the entry and the project | After the AI drafts an entry in `audit-exceptions.json`; the hook refuses an AI running it |
| `leak-scan` | Private files tracked in git, home paths inside tracked files, fonts loaded from a third-party host at runtime | Every commit (husky pre-commit) |
| `handoff` | The session holding uncommitted build-policy work declares it complete | End of a policy change made from an app session |
| `mirror-sync` | Copies `scripts/`, `templates/` and `tests/` to the public mirror and bumps its headers | From a build-policy session, before writing the public history row |
| `mirror` | Public-mirror drift + private-detail leak scan | Before pushing the public policy repo |

All commands refuse to run on a cloud-mounted path (`/Volumes/...`) — git must only ever touch the local sync folder.

---

## The workflow

Each step names its enforcement. **Human judgment** steps are deliberately human — everything else is machinery.

### Phase 1 — Session start

| Step | Enforced by |
|---|---|
| Compliance check runs and results are injected into context | SessionStart hook runs `policy check --hook` |
| Fix FAIL items before feature work (`policy scaffold` + manual fixes) | `policy check` re-run; gaps reappear every session until fixed |
| Every project has a filled-in `CLAUDE.md` | `check` FAILs when it is missing, still carrying the scaffold placeholder, or under 25 lines. `scaffold` writes the skeleton; the placeholder keeps it failing until the content is real |
| New project: spec in `.claude/specs/` before building | Human judgment (AI drafts, developer reviews the spec) |
| New repo: the developer makes the root commit (the scaffold) before any feature work, so the review gate, `/security-review` and the pre-commit marker have a HEAD to diff against | `check` FAILs a git repo with no commits, at session start; the pre-commit hook allows that one commit |

### Phase 2 — Planning

| Step | Enforced by |
|---|---|
| Assess scope: major (feature/architecture/multi-file) vs minor (bug fix/config) | Human judgment |
| Minor work: state intent in one sentence before starting | Human judgment |
| Major work: written plan — files affected, approach, risks — approved by developer before implementation | Human judgment (the developer is the gate) |
| Optional: import phases as Linear epics | Per-project |

### Phase 3 — Implementation

| Step | Enforced by |
|---|---|
| Follow the approved plan; build in testable phases | Human judgment |
| Never remove a constraint/guard introduced as a bug fix without explicit supersession — check the CHANGELOG first | Human judgment (see project-standards § Regression Prevention) |
| Cleanup pass: dead code, duplication (3+ repeats), no feature creep | Human judgment (see project-standards § Code Quality) |
| Validate at checkpoints; fast checks between edit and restart | Husky blocks commit if skipped; `verify-ready` blocks "ready" claim |

### Phase 4 — Quality gates

| Step | Enforced by |
|---|---|
| Full gate sequence: type-check → lint → HTML/CSS → format → secrets → allowlist → SAST → audit → licenses → CodeRabbit → build → smoke → integration → flows (where defined) | `policy gates` runs them in order, stops at first failure, writes diff-hashed marker. Registry signatures (`npm audit signatures`) are verified on every full run. One gate is conditional: CodeRabbit only when the diff contains source (or the tree is clean, or `--with-review`) |
| Fast subset on every commit (type-check, lint, HTML/CSS, format, secrets, allowlist) | Husky pre-commit runs `policy gates --fast` — **commit is impossible if it fails** |
| Gates re-run on GitHub: static checks, SAST, audit, licenses, **build, and every test tier** (+ gitleaks-action). `deps:check`, CodeRabbit and Socket stay local: `deps:check` resolves a sibling repo absent from a CI checkout, CodeRabbit is covered by its own GitHub app on PRs, and registry signatures plus a Socket score for each new package are checked locally before a dependency is approved (project-standards § Supply Chain Security) | GitHub Actions CI on every push/PR — **the durable evidence record** |
| Gates match the *current* diff (no edit-after-gates) | `verify-ready` compares marker hash to working tree |
| Full gates passed on the *exact tree being committed* — "ready to commit" cannot silently skip them | Husky pre-commit runs `policy verify-marker` — **commit is impossible if source or `package.json`/`package-lock.json` changed without a matching full-gates marker** |
| The lockfile installs in CI — a lockfile CI rejects never reaches a commit | Every `gates` run (fast pre-commit subset included) runs the lockfile-vs-`package.json` validation CI's install step performs, via npm's own validator; platform-independent, so a Mac answers for the Linux runner |
| Work committed after the last pass can still be gated | The marker records the HEAD it passed on; on a clean tree `gates` gates what was committed since (or since the last tag for older markers), reviews it with `--base-commit`, and carries the review forward when no source changed. `markerMatches` rejects a marker once a gated file it never saw is committed |

Root commit exception: CodeRabbit cannot review before HEAD exists, so the initial baseline commit may pass without a full-gates marker; immediately after it, full gates must run and every later source commit is gated normally.

### Phase 5 — Review

| Step | Enforced by |
|---|---|
| CodeRabbit findings addressed — all critical/high fixed before commit | `policy gates` includes `npm run review`; findings block the gate |
| Review allowance spent on code, not packaging: the review gate is skipped when the diff contains no source file, and is unconditional at release | `policy gates` skips it on a source-free diff (`--with-review` forces it); `verify-ready --release` FAILs unless the marker records a CodeRabbit pass |
| Security review for auth/data/payment/CORS/secret changes | `/security-review` (Claude Code; no CodeRabbit allowance), recorded with `policy security-ack`. Checked in **both** layers, like the gates marker: the Stop hook blocks turn-end when a sensitive file changed without a matching record, and `verify-ready` FAILs on the same condition. The review itself stays human judgment — the machinery checks that it happened, and against the current content (see Security Exclusions below) |
| Developer verifies the change locally in the UI | Human judgment — **the developer is the reviewer** |

### Phase 6 — Commit & version

| Step | Enforced by |
|---|---|
| CHANGELOG.md entry for every code change, written as public-safe project history | Stop hook blocks the AI's turn-end if source changed without it; `verify-ready` fails without it |
| Gates run before the AI presents work as ready — never left for the developer to remember to ask | Stop hook blocks turn-end if source or dependency files changed without a full-gates marker for the current tree (mid-iteration turns may state so and continue); `verify-marker` in pre-commit is the hard backstop |
| One session at a time holds uncommitted build-policy work, finishes it, and hands it off; only a build-policy session reviews it, maintains the public mirror and prepares the commit | `.policy/owner.json` moves editing → handed-off → released (developer commit). PreToolUse (Bash, Edit/Write) lets only the owner write while editing, only build-policy sessions after handoff, and only build-policy sessions write `build-policy-public`; Bash writes are judged by their targets, following `cd`. The owner's Stop hook blocks while `check` fails and, for an app session, until `policy handoff`. `policy mirror-sync` does the mechanical sync; `policy mirror` FAILs incident detail in new public text |
| A shipped version is frozen — new source work bumps the version and opens a new CHANGELOG section, never amends a shipped entry | A built DMG in `release/` marks its version shipped: Stop hook blocks turn-end, `check` fails, `verify-ready` fails while source changes sit on a shipped version |
| README updated when setup/features/config change | Human judgment (delegate to `readme-updater` agent) |
| Semver bump checked against last git tag | `verify-ready --release` fails if commits exist after the last tag without a bump (tag-at-HEAD = correctly tagged release) |
| Conventional commit on a feature branch | Human judgment — **the developer commits, never the AI** |

### Phase 7 — Release & deploy

| Step | Enforced by |
|---|---|
| Local apps: `npm run build && pm2 restart {app}` — never `npm run dev` | Stale-build banner (`buildCheck.js`) exposes skipped rebuilds |
| DMG build only after commit — never on a dirty tree | PreToolUse hook **denies** `electron:build` with uncommitted changes |
| Signing + notarization via keychain profile; verify with `codesign --verify --deep --strict` | Build fails unsigned; `doctor` checks the profile exists |
| If a build run from a Claude session fails with "No Keychain password item found", the developer runs `npm run electron:build` in Terminal.app, then the session resumes at the `codesign` check. The profile is fine; never re-create it, unlock the keychain or edit `.env` | PostToolUse/PostToolUseFailure hook detects the error on a build command and hands the build to the developer; `doctor` routes an unverifiable profile to a Terminal check before any `store-credentials` |
| The DMG container is signed, notarized and stapled too, not just the app inside it | `check` requires `afterAllArtifactBuild`; `verify-ready --release` assesses the built DMG with `spctl` + `stapler validate` |
| BYOK apps wire up both Anthropic and OpenAI, so no one vendor is a condition of use | `check` FAILs an Electron project calling one provider and not the other (matched on SDK import / API host) |
| External links open in the user's browser, not inside the app | `check` FAILs an Electron project with no `shell.openExternal` call |
| Every app carries the same settings footer: version, copyright, licences, Export diagnostics | `check` FAILs on each missing piece (version rendered only in the update banner; no copyright notice; a shipped `THIRD-PARTY-LICENSES.txt` nothing links to; no "Export diagnostics") |
| The update banner points at the app's changelog page, which carries the download link | `check` FAILs an app fetching `version.json` with no `/changelog/` URL; the site audit checks the page exists, links to the store, and is what `version.json` names |
| The update check re-runs while the app is open: on window focus/visibility and hourly, through one function throttled to once an hour | `check` FAILs an update-check file with no `setInterval` or no focus/`visibilitychange` listener |
| Settings has a manual Check for updates control beside the version. It uses the same check, bypasses the hourly throttle and reports current, available or failed status | `check` FAILs a version-checking desktop app with no Settings control or result feedback; the release checklist tests that it refreshes the banner |
| Third-party license attribution shipped (`THIRD-PARTY-LICENSES.txt`) | `verify-ready --release` fails without it |
| Release checklist (the list `verify-ready --release` prints is the source of truth): install new DMG over previous (dogfood; data migrated, core flow works) → **banner VISIBLE** in the new build while the site still lists the old version → upload DMG to the store + update site version.json/changelog/listing → **banner CLEARED** on relaunch. The site push is withheld until the developer confirms they **saw** the banner: once the new `version.json` is live the visible step can never be observed, and handing over the upload and push commands in the same list as the banner check invites skipping it. Relies on the mismatch banner (`site.version !== APP_VERSION`, project-standards § version check); apps still on a semver-newer comparison won't show the banner-visible step — migrate them to the mismatch check at their next release | `verify-ready --release` blocks until acknowledged with `--ack-manual` (recorded per version). **The developer runs the ack personally, never the AI** — it is a signature that the manual checks happened, and running it is the developer's once-per-release view of all remaining gaps; the PreToolUse hook denies AI attempts |
| The checklist matches how the project ships, set by `policy.distribution` in package.json: `gumroad` (dogfood, banner visible, upload, banner cleared, marketing), `none` (builds a DMG but is not distributed yet: dogfood only), `internal` (no DMG: rebuild, restart, verify one flow). Inferred when absent — Electron projects get `gumroad`, everything else `internal` | `verify-ready --release` prints only the steps that apply. A checklist naming steps the project cannot perform gets signed anyway, which empties the signature of meaning |
| With `"distribution": "none"` the DMGs in `release/` are test builds for the developer's own machine, so they freeze nothing: the version is not frozen, no tag is owed and no update banner is required. Those rules start when the project switches to a real distribution such as `gumroad`, which is the first real release. Before switching, bump the version or remove the test DMGs from `release/`, otherwise a leftover test build for the current version reads as a release that was never tagged. A project declared `gumroad` must have the update check before its first DMG, so the gap is caught before the launch build | `check`, `verify-ready` and the Stop hook read the shipped set through `shippedDmgVersions`, which is empty under `none`; `check` FAILs a declared-gumroad app with no update check even with no DMG built |
| `verify-ready --release` runs **twice**, either side of the build. Pre-flight (before the DMG exists) checks version bump, CHANGELOG, attribution and the gates marker; the manual checklist is performed after the build; the second run records the sign-off | Pre-flight PASSes with `Pre-build checks passed — build the DMG next` and prints the checklist as pending. Once a DMG exists for the version, an unacknowledged checklist FAILs |
| Tag the release commit once the DMG builds and verifies, before the store upload: `git tag v<version> && git push origin v<version>`. The tag is the durable record of what shipped, once `release/` is cleaned and DMGs are rebuilt. Tagging after the build, not before, keeps a tag off a version that failed notarization or was abandoned | `verify-ready --release` prints the command at pre-flight and **refuses to record the sign-off** for an untagged release; the developer creates the tag, as with commits |
| Marketing site (version.json, changelog, listing) + release marketing drafts | Human judgment — release isn't complete until the site reflects it |

### Phase 8 — Maintenance & improvement

| Step | Enforced by |
|---|---|
| Dependency health: outdated, audit, a Socket score due for risk-flagged packages (dormant, deprecated, archived, under 1,000 weekly downloads) | `policy health`; `check` flags every session once >30 days overdue |
| Homebrew installs verify bottle attestations, refuse insecure redirects and require cask checksums | `~/.homebrew/brew.env` written by `setup-machine`; `doctor` FAILs a missing setting, `HOMEBREW_NO_VERIFY_ATTESTATIONS`, or a signed-out `gh`; PreToolUse refuses `brew install`/`upgrade`/`reinstall`/`bundle` while attestation checks are off |
| Tooling currency: model IDs, action versions, tool choices re-verified on schedule | `registry.json` verified-dates; `check`/`health` flag stale entries — then web-search, update, propagate; `check` WARNs per project on AI model IDs that drift from the registry |
| Claude responses read by content-block type, so a thinking-by-default model cannot break parsing | `check` FAILs `content[0].text` in a project that names a thinking-by-default model (Sonnet 5, Opus 5/5.5, Fable, Mythos) and WARNs on it anywhere else |
| Thinking is turned off the way the model allows, so a smart-tier move cannot turn a quick task into a 400 | `check` FAILs `thinking: {type: 'disabled'}` in a project that names Sonnet 5.5, Opus 5.5, Fable or Mythos, and WARNs on it anywhere else (project-standards § AI Integration) |
| Allowlist entries are re-verified on schedule (180 days, 90 for security-sensitive packages) | `deps:check` FAILs an entry past its window, in the fast gate and pre-commit |
| The enforcement code is held to the policy: tested, security-reviewed, and its changelog closes every version | `check` on build-policy runs `tests/` (Node's built-in runner), FAILs a `scripts/`, `machine/` or `templates/` change without a `security-ack` bound to it, and FAILs when the CHANGELOG top section is not the current policy version. All three bind through the Stop hook and the policy repo's pre-commit |
| Dependabot PRs: minor/patch only, signatures verified and any new direct package Socket-scored before merge | `dependabot-reviewer` agent per branch; allowlist gate passes version-only bumps |
| GitHub issues triage; Cloudflare PRs/alerts for cloud apps | Human judgment + AI assistance |
| **Improvement loop:** when anything escapes — a user-reported bug, a regression, you catching yourself re-prompting — ask *"which check should have caught this?"* and add it to `policy.js`, a test, or a hook | Human judgment; the policy repo's git history is the record of the control system learning |
| Cross-project learning: one project's fix becomes the shared template/standard | Template drift detection — every project self-reports divergence at session start |

---

## Hotfix lane

When a paying user is broken, this is the sanctioned minimum path — defined here so pressure never improvises one:

1. Fix on a branch. 2. `policy gates` — **gates always run, no exceptions.** 3. CHANGELOG + patch version bump. 4. Developer reviews and commits. 5. `verify-ready --release` (the manual checklist may compress to: dogfood install + banner visible/cleared check). 6. Ship DMG + site update. 7. **Mandatory retro:** which check should have caught this? Add it before closing the incident.

What compresses: planning documents, marketing, non-urgent review threads. What never compresses: gates, changelog, developer commit, the retro.

---

## Security exclusions — always human-reviewed

Never modified by AI without explicit developer review and sign-off, regardless of tool:

- Authentication or authorisation logic
- API key handling or secret storage
- User data deletion, purges, or bulk destructive operations
- Payment or billing logic
- CORS, CSP, or security header configuration
- Anything that could expose or compromise user data

## Keychain rules (two different things — don't conflate)

- **Shipped apps must never store user secrets via Electron `safeStorage`/Keychain.** Entries go stale across re-signs and trigger scary prompts on user machines. Use AES-256-CBC with a machine-derived key (project-standards § Secret storage).
- **The dev machine's Keychain is exactly where notarization credentials belong.** `xcrun notarytool store-credentials <profile>` once per machine; projects reference `APPLE_KEYCHAIN_PROFILE` in `.env`. The password exists in no file. `policy doctor` verifies the profile.

## Data safety (details in project-standards)

Atomic writes; field whitelisting; read-all-then-write-all for multi-file ops; cascade deletes; **schema-version + migration-on-load + pre-migration backups + downgrade guard** for all user data; supply-chain protection (`min-release-age=2`, `npm audit` and `npm audit signatures` in the gates, a Socket score for every new or risk-flagged package, dependency allowlist with dual review).

**New packages are scored, installs are not wrapped.** Installs use npm directly. A package new to a project is verified with `verify-package.js`, which takes one Socket score and records it in the allowlist entry; `deps:check` refuses an entry approved from 2.58 on without that score or a waiver the developer wrote by hand. If Socket is unavailable the package waits.

## Model strategy

Session model is the developer's launch-time choice, never determined mid-session (currently **Claude Opus 5.5** for Claude Code, decided 2026-10-06: the current Opus, priced below Opus 5 at $4/$20 per MTok against $5/$25; Fable 5.1 for the hardest long-horizon sessions, credits permitting, with Opus 5.5 as the included-in-subscription fallback). Within a session, work shifts **down**, never up: mechanical work is **structurally** delegated to Haiku via pinned agent definitions in `~/.claude/agents/` (`changelog-writer`, `readme-updater`, `dependabot-reviewer`) — the model choice lives in the agent file, not in anyone's memory. Current model IDs live in `registry.json` with verified dates; `health` flags them for re-verification on schedule.

## Context protection

Tool call output persists in the conversation context and is resent on every subsequent turn. In long sessions with heavy inline tool use, this compounds and burns through token budgets. The delegation table (CLAUDE.md) says *who* does the work; this section says *how* the main session should use tools to keep context lean.

**Enforced by:** PreToolUse hook. When a Bash command matches a search or survey pattern (recursive grep, find, verbose git log, full git diff), the hook injects a reminder to delegate. The nudge is advisory, not a hard block, because inline use is sometimes the right call for a targeted, bounded lookup.

**Rules:**
- Search, grep, git exploration and disposable investigation go to haiku agents or forks. Their tool output never enters the main context.
- Verify before asserting. Test a hypothesis directly instead of theorising a cause then testing it: the latter pattern causes redundant re-runs.
- Prefer one targeted tool call over several exploratory ones. If research requires multiple steps, fork it.
- Read only the lines you need (`offset`/`limit`) rather than whole files.
- When a Bash command will produce more than a screenful of output, it belongs in a subagent.

## Evidence trail

**The authoritative evidence is machine-generated:** GitHub Actions CI logs (every push/PR — timestamped, third-party-hosted), git history (conventional commits, tags), CHANGELOG.md, PR review threads, `.policy/` markers, and the policy repo's own history (the control system's evolution). Changelog entries are required, but they must be public-safe: concise, factual, and free of customer names, private paths, internal counts, secrets, trade-secret details, or security-incident phrasing. Specs and plans live in `.claude/specs/` — gitignored, carried by your private file sync. They never reach GitHub, but keep them: they are the decision record for *why* changes were made. Local terminal output is working state, not evidence.

## Known limitations (stated, not hidden)

- **Performance has no gate.** Where it matters for an app, add a smoke-test assertion (e.g. response under N ms) in that project.
- **The machinery guarantees tests run, not that tests are good.** Coverage quality is judgment; the route-coverage check in `verify-ready` catches untested endpoints, not weak tests.
- **E2E (Playwright) is per-app** — where a project defines `test:flows`, full gates run it; adopt it for commercial apps with complex UI flows or help pages.
- **Crash telemetry is a deliberate product decision, not an omission** — apps ship with local diagnostics logging + user-initiated export instead (privacy-first).

## Machine setup (one-time)

Run `policy setup-machine` — it installs the per-machine wiring from the canonical copies in `machine/` (session-start script, Claude Code hooks merged into `~/.claude/settings.json`, haiku agents) and prints the remaining manual steps. Then `policy doctor` verifies everything:

Node LTS (nvm) · PM2 · git · Semgrep (brew) · Betterleaks (brew) · Socket CLI, wrapper off (`socket login`, used to score packages) · `~/.npmrc` `min-release-age=2` · Claude Code hooks · haiku agents · notary keychain profile (`xcrun notarytool store-credentials`). Per-project quality tooling is devDependencies, installed by scaffold + `npm install`. The machine wiring lives in the repo, not in anyone's memory — a fresh computer is one command plus the printed manual steps away from fully enforced.

## Cross-LLM configuration

Context files (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/`) are **local-only and gitignored in every repo** — synced between machines by file sync, never pushed to GitHub. GitHub needs only what CI runs: `.github/`, package.json scripts, and tool configs — all public-safe. Each context file should be thin: project facts (stack, architecture, key files, gotchas) plus the policy commands; the process itself lives in `policy.js`, so all tools get the same process by construction. Paths in context files use `~` (home differs across machines); mind that they must resolve to the **local** sync folder, never the cloud mount — `policy.js` hard-fails on `/Volumes/` paths.

## Public mirror

The sanitised public copy lives in `build-policy-public/` → pushed to `THIS-REPO`, including `scripts/` and `templates/` so the enforcement is publicly verifiable. `policy mirror` checks version drift and scans for private details (blocklist in `mirror-blocklist.txt`, never mirrored). Run it before every public push.

Only a session opened in build-policy edits the public copy. `policy mirror-sync` copies `scripts/` and `templates/` and bumps the headers; the public history rows and standards text are written by hand and state the rule and how it is enforced, never where it was found, which product, an endpoint or a plan. `policy mirror` FAILs new public text that does.

---

## Version history

Kept in `HISTORY.md`, one row per policy version, so this document stays readable in one sitting. `check` reads that table: the header above must match its newest row, versions are unique and newest-first, and every policy version the top CHANGELOG.md section cites has a row there.
