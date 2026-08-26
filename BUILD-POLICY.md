# Build & Development Policy

**Version:** 2.20
**Last updated:** 2026-08-25

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
| `check` | Project compliance: required scripts/files/configs, template drift, staleness | **Automatically at every session start** (Claude hook); after fixing gaps |
| `scaffold` | Creates missing standard files and scripts; never overwrites | New projects; fixing `check` gaps |
| `gates` | Runs all quality gates in order; writes a diff-hashed pass marker | Before presenting any work (`/gates`); `--fast` subset on every commit (husky) |
| `verify-ready` | Marker matches current diff + CHANGELOG updated + smoke coverage | Before declaring work ready; `--release` before shipping |
| `health` | npm outdated/audit, registry staleness; records run timestamp | When `check` flags maintenance overdue (>30 days) |
| `upgrade <pkg>` | Grounds a major dependency upgrade in npm facts (real peer constraints, migration source); scaffolds a decision record | Before any major version bump; `check`/`verify-ready` FAIL without the record |
| `deps-update` | Refreshes dependencies inside their declared ranges (minor/patch); majors untouched | When `check` reports drift; before starting feature work |
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
| Full gate sequence: type-check → lint → HTML/CSS → format → secrets → allowlist → SAST → audit → licenses → CodeRabbit → build → smoke → integration | `policy gates` runs them in order, stops at first failure, writes diff-hashed marker |
| Fast subset on every commit (type-check, lint, HTML/CSS, format, secrets, allowlist) | Husky pre-commit runs `policy gates --fast` — **commit is impossible if it fails** |
| Gates re-run on GitHub: static checks, SAST, audit, licenses, **build, and every test tier** (+ gitleaks-action). `deps:check`, CodeRabbit and Socket stay local: `deps:check` resolves a sibling repo absent from a CI checkout, CodeRabbit is covered by its own GitHub app on PRs, and Socket runs at install time via the wrapper plus a pre-merge scan of Dependabot branches (project-standards § Supply Chain Security) | GitHub Actions CI on every push/PR — **the durable evidence record** |
| Gates match the *current* diff (no edit-after-gates) | `verify-ready` compares marker hash to working tree |
| Full gates passed on the *exact tree being committed* — "ready to commit" cannot silently skip them | Husky pre-commit runs `policy verify-marker` — **commit is impossible if source changed without a matching full-gates marker** |

Root commit exception: CodeRabbit cannot review before HEAD exists, so the initial baseline commit may pass without a full-gates marker; immediately after it, full gates must run and every later source commit is gated normally.

### Phase 5 — Review

| Step | Enforced by |
|---|---|
| CodeRabbit findings addressed — all critical/high fixed before commit | `policy gates` includes `npm run review`; findings block the gate |
| Security review for auth/data/payment/CORS/secret changes | Human judgment + `/security-review` (see Security Exclusions below) |
| Developer verifies the change locally in the UI | Human judgment — **the developer is the reviewer** |

### Phase 6 — Commit & version

| Step | Enforced by |
|---|---|
| CHANGELOG.md entry for every code change, written as public-safe project history | Stop hook blocks the AI's turn-end if source changed without it; `verify-ready` fails without it |
| Gates run before the AI presents work as ready — never left for the developer to remember to ask | Stop hook blocks turn-end if source changed without a full-gates marker for the current tree (mid-iteration turns may state so and continue); `verify-marker` in pre-commit is the hard backstop |
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
| Third-party license attribution shipped (`THIRD-PARTY-LICENSES.txt`) | `verify-ready --release` fails without it |
| Release checklist (the list `verify-ready --release` prints is the source of truth): install new DMG over previous (dogfood; data migrated, core flow works) → **banner VISIBLE** in the new build while the site still lists the old version → upload DMG to Gumroad + update site version.json/changelog/listing → **banner CLEARED** on relaunch. Relies on the mismatch banner (`site.version !== APP_VERSION`, project-standards § version check); apps still on a semver-newer comparison won't show the banner-visible step — migrate them to the mismatch check at their next release | `verify-ready --release` blocks until acknowledged with `--ack-manual` (recorded per version). **The developer runs the ack personally, never the AI** — it is a signature that the manual checks happened, and running it is the developer's once-per-release view of all remaining gaps; the PreToolUse hook denies AI attempts |
| The checklist matches how the project ships, set by `policy.distribution` in package.json: `gumroad` (dogfood, banner visible, upload, banner cleared, marketing), `none` (builds a DMG but is not distributed yet: dogfood only), `internal` (no DMG: rebuild, restart, verify one flow). Inferred when absent — Electron projects get `gumroad`, everything else `internal` | `verify-ready --release` prints only the steps that apply. A checklist naming steps the project cannot perform gets signed anyway, which empties the signature of meaning |
| `verify-ready --release` runs **twice**, either side of the build. Pre-flight (before the DMG exists) checks version bump, CHANGELOG, attribution and the gates marker; the manual checklist is performed after the build; the second run records the sign-off | Pre-flight PASSes with `Pre-build checks passed — build the DMG next` and prints the checklist as pending. Once a DMG exists for the version, an unacknowledged checklist FAILs |
| Tag the release commit once the DMG builds and verifies, before the Gumroad upload: `git tag v<version> && git push origin v<version>`. The tag is the durable record of what shipped, once `release/` is cleaned and DMGs are rebuilt. Tagging after the build, not before, keeps a tag off a version that failed notarization or was abandoned | `verify-ready --release` prints the command at pre-flight and **refuses to record the sign-off** for an untagged release; the developer creates the tag, as with commits |
| Marketing site (version.json, changelog, listing) + release marketing drafts | Human judgment — release isn't complete until the site reflects it |

### Phase 8 — Maintenance & improvement

| Step | Enforced by |
|---|---|
| Dependency health: outdated, audit, Socket scan (`--socket`) | `policy health`; `check` flags every session once >30 days overdue |
| Tooling currency: model IDs, action versions, tool choices re-verified on schedule | `registry.json` verified-dates; `check`/`health` flag stale entries — then web-search, update, propagate |
| Dependabot PRs: minor/patch only, Socket-scanned before merge | `dependabot-reviewer` agent per branch; allowlist gate passes version-only bumps |
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

Atomic writes; field whitelisting; read-all-then-write-all for multi-file ops; cascade deletes; **schema-version + migration-on-load + pre-migration backups + downgrade guard** for all user data; supply-chain protection (Socket wrapper, `min-release-age=1`, dependency allowlist with dual review).

**Socket install fallback.** Socket is the default supply-chain control. Do not disable or bypass scanning. If the wrapper cannot complete a first install because the dependency tree is too large or quota/rate-limited, bypass only the wrapper's package-by-package install path: `socket raw-npm install --ignore-scripts`, then `socket scan create --report` over the resolved tree, then `npm rebuild` only after the scan is clean. For bounded upgrades during a 429, follow project-standards § Supply Chain Security: score the target version first, run the raw npm command, scan the resulting tree, and inspect the lockfile diff.

## Model strategy

Session model is the developer's launch-time choice, never determined mid-session (currently **Claude Opus 5** for Claude Code, decided 2026-07-26 — released 2026-07-24 at the same price as Opus 4.8; Fable 5 reserved for the hardest long-horizon sessions, credits permitting, with Opus 5 as the included-in-subscription fallback). Within a session, work shifts **down**, never up: mechanical work is **structurally** delegated to Haiku via pinned agent definitions in `~/.claude/agents/` (`changelog-writer`, `readme-updater`, `dependabot-reviewer`) — the model choice lives in the agent file, not in anyone's memory. Current model IDs live in `registry.json` with verified dates; `health` flags them for re-verification on schedule.

## Evidence trail

**The authoritative evidence is machine-generated:** GitHub Actions CI logs (every push/PR — timestamped, third-party-hosted), git history (conventional commits, tags), CHANGELOG.md, PR review threads, `.policy/` markers, and the policy repo's own history (the control system's evolution). Changelog entries are required, but they must be public-safe: concise, factual, and free of customer names, private paths, internal counts, secrets, trade-secret details, or security-incident phrasing. Specs and plans live in `.claude/specs/` — gitignored, carried by your private file sync. They never reach GitHub, but keep them: they are the decision record for *why* changes were made. Local terminal output is working state, not evidence.

## Known limitations (stated, not hidden)

- **Performance has no gate.** Where it matters for an app, add a smoke-test assertion (e.g. response under N ms) in that project.
- **The machinery guarantees tests run, not that tests are good.** Coverage quality is judgment; the route-coverage check in `verify-ready` catches untested endpoints, not weak tests.
- **E2E (Playwright) is future tier** — adopt per-app for commercial apps with complex UI flows.
- **Crash telemetry is a deliberate product decision, not an omission** — apps ship with local diagnostics logging + user-initiated export instead (privacy-first).

## Machine setup (one-time)

Run `policy setup-machine` — it installs the per-machine wiring from the canonical copies in `machine/` (session-start script, Claude Code hooks merged into `~/.claude/settings.json`, haiku agents) and prints the remaining manual steps. Then `policy doctor` verifies everything:

Node LTS (nvm) · PM2 · git · Semgrep (brew) · Betterleaks (brew) · Socket CLI (`socket wrapper on`) · `~/.npmrc` `min-release-age=1` · Claude Code hooks · haiku agents · notary keychain profile (`xcrun notarytool store-credentials`). Per-project quality tooling is devDependencies, installed by scaffold + `npm install`. The machine wiring lives in the repo, not in anyone's memory — a fresh computer is one command plus the printed manual steps away from fully enforced.

## Cross-LLM configuration

Context files (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/`) are **local-only and gitignored in every repo** — synced between machines by file sync, never pushed to GitHub. GitHub needs only what CI runs: `.github/`, package.json scripts, and tool configs — all public-safe. Each context file should be thin: project facts (stack, architecture, key files, gotchas) plus the policy commands; the process itself lives in `policy.js`, so all tools get the same process by construction. Paths in context files use `~` (home differs across machines); mind that they must resolve to the **local** sync folder, never the cloud mount — `policy.js` hard-fails on `/Volumes/` paths.

## Public mirror

The sanitised public copy lives in `build-policy-public/` → pushed to `THIS-REPO`, including `scripts/` and `templates/` so the enforcement is publicly verifiable. `policy mirror` checks version drift and scans for private details (blocklist in `mirror-blocklist.txt`, never mirrored). Run it before every public push.

---

## Version history

| Version | Date | Changes |
|---|---|---|
| 2.20 | 2026-08-25 | A new project can now be set up without exhausting the supply-chain scan allowance. The Socket wrapper scans package by package, so a first install of a normal stack costs several hundred scans against 1,000/month and fails partway once the allowance runs low. The standards then offered no way out: `raw-npm` is the sanctioned remedy when the wrapper is unavailable, but its first precondition forbids a blanket install of arbitrary new dependencies, which is exactly what a first install is. Resolved by scanning the resolved tree instead of each package, which costs one scan for the same coverage: `raw-npm install --ignore-scripts` so nothing executes, `socket scan create --report` over the whole tree, then `npm rebuild` only once it is clean. Recorded as an explicit exception to that precondition. Also corrects the 429 guidance, which described a rate limit that clears by waiting; it can instead be a depleted quota, where each retry consumes what is left. `socket organization quota` distinguishes them and is now checked before retrying. |
| 2.19 | 2026-08-23 | Electron is audited, having been the one thing the security gate never looked at. `security` is `npm audit --audit-level=high --omit=dev` on the reasoning that the gate models shipped risk and dev dependencies do not ship (2.4.1). That premise is false for exactly one package: Electron sits in devDependencies but electron-builder bundles it into the DMG, so Chromium, the largest attack surface in the shipped app, was excluded. `gates` now audits the full tree for Electron projects and fails on an Electron high or critical advisory only, leaving dev-chain advisories out of the gate as 2.4.1 intended. Placed in `gates` rather than `check` because it is a network call and the session-start hook has a 10 second budget. Most Electron projects flag today; the clean ones are those whose lockfiles had already resolved to fixed versions. Also collapses a registry contradiction introduced in 2.15: a new `node-version` entry was added alongside the existing `node-lts` instead of updating it, leaving two entries for one fact. |
| 2.18 | 2026-08-23 | A half-set-up project no longer reports PASS. `check` classified any project without a `package.json` as documentation-only and skipped every structural check, including all four template-drift checks, so a project carrying `AGENTS.md`, `.husky/` and a CI workflow was told it was compliant while nothing had been examined. Given a green light, a wrong label and no next action, a session reasoned from scratch and got it wrong: it concluded its freshly scaffolded files were stale and proposed deleting six of them, `CHANGELOG.md` included, when all were byte-identical to the current templates. `check` now FAILs a project with scaffolding present but no `package.json`, naming the state and the next step, and the session-start hook injects that. Genuinely documentation-only projects are unaffected, since the signal is scaffolding artifacts rather than the absence of a manifest. |
| 2.17 | 2026-08-23 | `scaffold` now writes the Electron skeleton, closing the reason projects were copied. 2.16 enforced the four Electron prohibitions but left the cause in place: the only Electron-specific file `scaffold` produced was `entitlements.mac.plist`, so a session building a new app had prose and nothing to copy, and reached for whichever project was nearest — including one carrying an in-app licence gate, `safeStorage` and no `findFreePort()`. Two templates added, adapted from the reference implementation the standards already name: `electron/main.js` (findFreePort, contextIsolation, native title bar) and `server/secret-storage.js` (AES-256-CBC with a machine-derived key, `enc:` prefix, plaintext migration). Both syntax-checked; the secret storage round-trips and passes plaintext through. A freshly scaffolded Electron project passes the 2.16 standards check with no edits. |
| 2.16 | 2026-08-23 | The four Electron prohibitions in project-standards are enforced. They were prose, so a new app scaffolded by copying a nearby project inherited whatever that project did, and the divergence then read as house style rather than as a defect. `check` now FAILs an Electron project that carries a puppeteer dependency, calls the store licence API, uses `safeStorage`, or has no `findFreePort()`. Checking the outcome is possible where checking "read the standards first" is not. Matching is on imports and calls with comment lines skipped, because one project discusses `safeStorage` only to record that it moved off it and flagging that would teach people to ignore the check. Verified across every Electron project: most clean, two flagged, non-Electron projects unaffected, 0.1s. |
| 2.15 | 2026-08-22 | Lockfile integrity is checked, after a filtered `package-lock.json` broke a CI build. One commit removed 50 entries: every cross-platform binary for rolldown, lightningcss and `@tailwindcss/oxide`, while leaving the `optionalDependencies` that declare them in place. The result installs on the machine that made it and fails on Linux, and npm does not produce it — verified across `--package-lock-only`, `npm update`, a from-scratch regeneration and a real `--omit=optional` install, all of which keep the full graph. `check` and `gates` now FAIL when a lockfile declares two or more platform-named siblings and has resolutions for fewer, and `gates` checks it before running anything so a broken lockfile costs nothing to catch. Verified against every project lockfile: none flag; the broken revision flags four entries. Genuinely optional native modules such as `canvas` are excluded by design. Standards now state that the lockfile is generated, never authored. Separately from the same investigation, the CI node version was pinned to 22 while local development runs 24, so CI resolved and installed with a different npm major than the one that wrote the lockfile. `templates/ci.yml` now pins 24, matching local; both are LTS (Krypton and Jod, verified against nodejs.org release data) and no project declares an engines constraint below it. Tracked in `registry.json` so the pin is re-checked when local node moves. |
| 2.14 | 2026-08-21 | Recorded which enforcement layer a check belongs in, so the question is not re-decided differently later. Claude Code hooks fire while the AI works, so the AI sees the failure in context and fixes it before the developer looks; git hooks fire on `git commit`, which is the developer's action, so a failure there interrupts the person who did not cause it and the fix goes back to the AI anyway. Git hooks are the backstop and carry only what must never land whatever the tool: secrets, private data, unverified code. A rule belongs in both layers only when the consequence is permanent, as with the gates marker. Moving checks into the git layer to compensate for agents that have no Claude hooks was considered and rejected: it delays feedback for every tool and taxes every commit, when the fix is for those agents to run the commands `AGENTS.md` lists. |
| 2.13 | 2026-08-21 | `CLAUDE.md` is enforced rather than requested. The requirement lived only in Phase 1 marked "human judgment", so nothing verified it and a third of projects had none: an unenforced rule behaving the way unenforced rules do, in a policy whose first principle is that prose is never the enforcement layer. It was left out of the required-files list because it is gitignored, but existence does not depend on git. `check` now FAILs when the file is missing, still carrying the scaffold placeholder, or under 25 lines, and `scaffold` writes a skeleton from `templates/CLAUDE.md` that keeps failing until the placeholders are replaced, so scaffolding cannot close the gap on its own. The content floor is set from evidence: every existing file clears 25 lines, while heading-based rules would have failed many of them. |
| 2.12 | 2026-08-21 | The release checklist now matches how a project actually ships. Every project was handed the same paid-app list, so a web app was told to build a DMG and upload it, and an app not yet distributed was asked to confirm an update banner against a site listing that does not exist. A checklist naming steps the project cannot perform gets signed anyway, which empties the signature of meaning. Three profiles, set by `policy.distribution` in package.json: `gumroad` unchanged; `none` for an app that builds a DMG but is not distributed yet, which drops the upload and banner steps; `internal` for anything with no DMG, which asks for a rebuild, restart and one verified flow instead. Absent the key, Electron projects infer `gumroad` and everything else `internal`. The pre-build staging that reports pending work rather than failing applies only to the DMG-producing profiles, since the others have no artifact to wait for. |
| 2.11 | 2026-08-20 | Releases are now tagged, and the tag is enforced. `verify-ready --release` read `git describe --tags` to check the version bump, but nothing in this tool ever created a tag and Phase 7 never named the step, so most projects had none and the check degraded to a warning; those that had one were tagged once and left behind. The tag matters because `release/` gets cleaned and DMGs get rebuilt, after which nothing marks the commit a version was cut from. Pre-flight now prints `git tag v<version> && git push origin v<version>` alongside the manual checklist, and the sign-off refuses to record an untagged release, so `--ack-manual` cannot certify a release with no durable marker. A tag that exists but does not point at HEAD warns rather than fails. Existing untagged histories are left alone; tagging starts at each project's next release. |
| 2.10 | 2026-08-20 | Dependencies now have a local refresh lane. Dependabot was the only thing updating them, raising one PR per package; those queue faster than the review-scan-merge cycle clears them, leaving lockfiles ageing while local work continues against them. New `policy deps-update` runs `npm update`, which moves each package to the newest version its declared range permits without rewriting the ranges in `package.json` (npm's documented behaviour); with `save-prefix = ^` that confines it to minor and patch, and majors still require `policy upgrade <pkg>`. Existing guardrails cover it: the lockfile changing triggers the Socket scan in `gates` (2.7), `min-release-age=1` quarantines fresh publishes, and full gates must pass before a commit. `check` warns at session start when more than 10 packages are behind and the last refresh is over 30 days old, with the count cached daily so the hook's 10 second budget is not spent on a network call. |
| 2.9.1 | 2026-08-16 | `verify-ready --release` now distinguishes its two stages. Every item on the manual checklist needs the built DMG (install it, confirm the update banner, upload it), but the pre-flight run, which happens before the build as the build order requires, reported a hard FAIL for the unacknowledged checklist. That reads as a blocker to clear before building, and the only thing that can clear it is the artifact that does not exist yet, so sessions stalled or looked for a way to build early. Pre-flight now PASSes with `Pre-build checks passed — build the DMG next` and lists the checklist as pending work with its sign-off command. Once a DMG exists for the version, an unacknowledged checklist FAILs as before. |
| 2.9 | 2026-08-16 | The gates marker no longer expires at the moment of commit. `diffHash` hashes the changed-file list *relative to HEAD*, so `git commit` emptied that list and invalidated a marker without a byte of verified code changing: gates → commit → any further work demanded a full re-run, CodeRabbit included, of gates that had just passed on identical content. The marker now also records the verified file list and a `contentHash` over their contents, and `markerMatches` accepts it when the verified content is unchanged and nothing outside that set has changed — whether the content is committed or not. Verified across the sequence: valid before commit, valid after commit, invalid on an edit, valid again when that edit is reverted, invalid when a new file appears; `verify-marker` still blocks a commit carrying unverified changes, and markers written before this version behave exactly as they did. |
| 2.8 | 2026-08-13 | Privacy checks moved from report to control. The tracked-file scans ran only in `check` at session start, so a finding could be seen and passed over; internal portfolio detail (project counts, outstanding remediation, which controls were absent and when) had also reached the public changelog, which no scan covered because it names nothing private. Now: `policy leak-scan` runs in `.husky/pre-commit` for every project and exits non-zero on any finding, sharing one implementation with `check` via `auditTrackedPrivacy`; `mirror` FAILs on internal portfolio prose in the public copy; and `setup-machine` installs a `pre-push` guard on the public mirror that runs `mirror` before anything reaches the remote. |
| 2.7.2 | 2026-08-10 | Content-level leak scanning extended from the policy mirror to every project. `mirror` scanned file contents for private details; project `check` verified only that private *files* were gitignored and untracked, so identifying content inside a legitimately tracked file passed every gate — the case being an absolute home path in generated attribution. `check` now FAILs on `/Users/<name>/...` or `/home/<name>/...` in any tracked file, ignoring placeholder usernames (`you`, `yourname`, `example`) so docs and UI hints are unaffected. |
| 2.7.1 | 2026-08-10 | `licenses:file` no longer writes the build machine's home directory into shipped attribution. `license-checker --production` prints absolute paths in both `path:` and `licenseFile:` (`--relativeLicensePath` fixes only the second, and `--customPath` cannot drop a field), so the standard script strips the build root. `verify-ready --release` now FAILs when `THIRD-PARTY-LICENSES.txt` contains `/Users/<name>/...`. |
| 2.7 | 2026-08-07 | Socket supply-chain scanning enforced. It was previously a per-shell npm wrapper alias plus an optional `health --socket` flag, with no CI step, so any other shell, machine or runner had no scanning. `socket:scan` (`socket ci`) is now a required script, run in local full gates only when `package.json` or `package-lock.json` changed (free tier: 1,000 scans/month). Scanning stays **local**: the wrapper covers installs and `socket:scan` covers Dependabot branches pre-merge, which between them cover every path into the lockfile — so the template deliberately carries **no CI step** and no `SOCKET_SECURITY_API_KEY` requirement. Documents the required token scopes and the `socket raw-npm` bypass procedure for wrapper 429s. CLI version pinned in the template and tracked in `registry.json`. |
| 2.6.2 | 2026-08-01 | CI runs build and tests. `templates/ci.yml` adds `build`, `test:unit`, `test:smoke` and `test:integration`, each `--if-present`. `deps:check` remains local — it resolves a sibling repo absent from a CI checkout — and CodeRabbit remains out, covered by its GitHub app on PRs; both omissions are noted in the template. The workflow table now describes what CI actually runs.yml` need a template sync. |
| 2.6.1 | 2026-08-01 | `gates` now parses the CodeRabbit `--agent` output instead of relying on the exit code. On a clean tree with the branch equal to its base, CodeRabbit exits 0 with `"status":"review_skipped"`, which was recorded in the marker as a passing review gate. A review that examined nothing now FAILs, and the failure names the recovery options for already-committed work (`--base-commit <sha>`, or a PR / scratch-repo review for a root commit). |
| 2.6 | 2026-08-01 | Review gate scope and new-repo support. `review` is now `coderabbit review --agent --include-untracked`: the CLI default covers tracked changes only, and gates run before staging, so new files passed the gate unreviewed. `check` FAILs without the flag. CodeRabbit requires an existing branch (`git rev-parse --abbrev-ref HEAD`) and, with no remote, `git config coderabbit.baseBranch <branch>`. `verify-marker` waives itself when there is no HEAD, allowing the root commit; `gates` preflights both conditions. |
| 2.5.1 | 2026-07-29 | `changedFiles()` now uses `git status --porcelain -uall`. Plain `--porcelain` collapses an untracked directory to a single `?? dir/` entry but lists its files individually once staged, so `git add` changed `diffHash` and invalidated a valid gates marker. `readFile()` on a directory path returns an empty string, so a new directory's contents hashed as nothing and edits inside it did not invalidate a marker. No check-result changes across the portfolio. |
| 2.5 | 2026-07-28 | Portfolio consistency baselines. Prettier: `semi`, `singleQuote`, `tabWidth`, `printWidth` must match the house baseline; `trailingComma`, `arrowParens`, `plugins` and `endOfLine` remain per-project. Testing: a stub `test:smoke` (`echo`, `exit 0`, `npm run build`) FAILs, and `tests/smoke.js` plus `tests/harness.js` are required for any project with a server. Optional `test:unit` tier added for logic requiring no server. |
| 2.4.3 | 2026-07-28 | Policy-doc version self-consistency enforced. `auditPolicyDocVersions` (run by `check` inside the policy repo, and by `mirror` against both copies): the `**Version:**` header must equal the highest version in the history table, the table must read newest-first, and `project-standards.md` must carry the same version. The header had remained at 2.4 across two patch entries, and `mirror` compared only the two headers to each other. Also adds `.prettierrc` to the policy repo and formats `scripts/` to it. |
| 2.4.2 | 2026-07-25 | Semgrep exclusion creep reverted and enforced: four unsanctioned global exclusions had accreted into the CI template and project sast scripts (incl. `express-puppeteer-injection`, added to silence a finding on code that violates the pdfmake standard, and `unsafe-formatstring`/`prototype-pollution-loop`/`raw-html-format`, which were hiding zero findings). Template + scripts reset to the sanctioned four; `check` now FAILs any sast script carrying an exclusion beyond them (fewer is fine — per-line nosemgrep is stricter). One Electron app's puppeteer PDF export suppressed per-line with the migration debt named (pdfmake/printToPDF at next planned work). |
| 2.4.1 | 2026-07-25 | Audit gate standardised after per-project improvisation: `security` = `npm audit --audit-level=high --omit=dev` (gate models SHIPPED risk; malicious-package risk in dev deps is covered by Socket + allowlist + cooldown, which npm audit cannot see). Compensating control: `policy health` audits the FULL tree incl dev and warns on dev-only advisories. `check` now FAILs on any non-standard `security` script — weakened audit levels are never sanctioned (one project had silently dropped to `critical`). |
| 2.4 | 2026-07-25 | Major dependency upgrades grounded, not guessed. New `upgrade <pkg>` command pulls the target's REAL `peerDependencies`, installed version, and upstream migration source from `npm view` (flagging peers where the project is below the required major), then scaffolds a decision record under `.claude/specs/deps/`. `check` and `verify-ready` now FAIL when a dependency's major increased in the working tree without a matching record (`auditMajorUpgrades`, pre-commit window like the CHANGELOG check). Closes the gap where different sessions reasoned about a migration from model memory and reached conflicting/fabricated conclusions (e.g. an invented peer constraint) — anti-fabrication rule added: migration claims must cite tool output, never recalled knowledge. |
| 2.3 | 2026-07-22 | Public-repo hardening + drift closure. New `check` gates: `.gitignore` effectiveness verified via `git check-ignore` against every private path (not substring matching) plus a tracked-private-files scan (both catch context/data files before a repo goes public); `dependabot.yml` and `.prettierrc` template-drift (quote-normalised; `.prettierrc` must set `singleQuote: true` — a missing config silently formatted on double-quote defaults). Mirror: byte-level `scripts/`+`templates/` drift check (verbatim-mirror promise now enforced), and an Apple app-specific-password shape pattern in the leak scan (literal removed from the blocklist; scan checks every match, not just the first). Semgrep: only the four documented global exclusions are sanctioned — everything else is per-line `// nosemgrep`; `dependabot-missing-cooldown` must never be excluded (it means the `cooldown` block is missing). Dependabot `cooldown` restored with valid `default-days` keys (earlier `semver-minor:`/`semver-patch:` were invalid). CodeRabbit: CLI (`npm run review`) is the enforced gate, plugin skills (`coderabbit:code-review`, `coderabbit:autofix`) named correctly and scoped to what the CLI can't do. |
| 2.2 | 2026-07-16 | Shipped-version freeze: a built DMG (or a git tag at HEAD) marks its version frozen — Stop hook, `check`, `verify-ready`, and the DMG build guard all block source work or builds on a shipped/mismatched version; CHANGELOG top entry and package.json must move together (changelog-writer agent bumps both). Release: checklist rewritten around the deliberate mismatch update-banner (visible against stale site → cleared after site update; marketing drafts added); `--ack-manual` is developer-only (PreToolUse denies AI attempts); tag-at-HEAD recognised as correct release state. Smoke-coverage gaps ratcheted: baseline recorded per project, new uncovered API routes FAIL, baseline only shrinks. |
| 2.1 | 2026-07-13 | Commit-time gates enforcement: `verify-marker` in pre-commit blocks source commits without a full-gates pass on the exact tree; Stop hook extended to require a valid gates marker (or explicit mid-iteration statement) at turn-end; staging-invariant diff hash. SAST fixed to actually block locally (`--error` in sast standard + drift check) with triaged semgrep exclusions documented in project-standards. Supply chain: all CI actions SHA-pinned (template drift propagates). Agent-agnostic: AGENTS.md template (scaffold + check + drift) so non-Claude agents get the policy; PreToolUse redirect of raw `semgrep scan` to `npm run sast`. `.policy/` gitignore required by check; policy state files written prettier-clean. |
| 2.0 | 2026-07-13 | Enforcement-first rewrite: policy.js single entrypoint (doctor/check/scaffold/gates/verify-ready/health/mirror), hooks that block (session-start compliance injection, Stop changelog guard, PreToolUse DMG guard), every step now names its enforcement. Added: release checklist with update-banner verification, hotfix lane, improvement loop, verified-dates registry, template drift detection, file sync cloud-mount guard, keychain rules (notarytool profile vs safeStorage ban), attribution file requirement, migration/backup/downgrade-guard standards, haiku agent definitions, known-limitations section. Fixed: validate script mismatch, gitignore template conflicts (.claude/ vs specs; build/ vs Electron assets), Semgrep added to CI, home-dir-portable paths. |
| 1.5 | 2026-07-10 | Migrated local secret scanning from Gitleaks to Betterleaks; fixed duplicate step 40 numbering |
| 1.4 | 2026-07-07 | Gitleaks Homebrew-only; dependency allowlist with dual review; CodeRabbit in automated pipeline; shared scripts |
| 1.3 | 2026-06-28 | Model strategy, standing rules, marketing-site deploy step, expanded compliance check |
| 1.2 | 2026-06-28 | Code quality principles, cleanup pass |
| 1.1 | 2026-06-28 | Compliance check, deploy order (commit before DMG), automatic changelog/version/README, developer as committer |
| 1.0 | 2026-06-28 | Initial policy |
