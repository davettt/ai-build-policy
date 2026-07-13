# Build & Development Policy

**Version:** 2.0
**Last updated:** 2026-07-13

Single source of truth for how we build, maintain, and ship software. Every AI assistant (Claude, Codex, or other) and every human developer follows this workflow.

## The enforcement principle

**Every step in this policy is either enforced by a machine or evidenced by an artifact a machine checks. Prose is never the enforcement layer.** LLMs follow instructions probabilistically; programs execute the same way every time. So the process lives in `scripts/policy.js` and its hooks, and this document describes the control system for people. An AI tool doesn't need to memorise this document — it needs to run the commands and respond to what they report.

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
| New project: create CLAUDE.md + spec in `.claude/specs/` before building | Human judgment (AI drafts, developer reviews the spec) |

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
| Same gates re-run on GitHub (+ Semgrep, gitleaks-action) | GitHub Actions CI on every push/PR — **the public record** |
| Gates match the *current* diff (no edit-after-gates) | `verify-ready` compares marker hash to working tree |

### Phase 5 — Review

| Step | Enforced by |
|---|---|
| CodeRabbit findings addressed — all critical/high fixed before commit | `policy gates` includes `npm run review`; findings block the gate |
| Security review for auth/data/payment/CORS/secret changes | Human judgment + `/security-review` (see Security Exclusions below) |
| Developer verifies the change locally in the UI | Human judgment — **the developer is the reviewer** |

### Phase 6 — Commit & version

| Step | Enforced by |
|---|---|
| CHANGELOG.md entry for every code change | Stop hook blocks the AI's turn-end if source changed without it; `verify-ready` fails without it |
| README updated when setup/features/config change | Human judgment (delegate to `readme-updater` agent) |
| Semver bump checked against last git tag | `verify-ready --release` fails if version equals last tag |
| Conventional commit on a feature branch | Human judgment — **the developer commits, never the AI** |

### Phase 7 — Release & deploy

| Step | Enforced by |
|---|---|
| Local apps: `npm run build && pm2 restart {app}` — never `npm run dev` | Stale-build banner (`buildCheck.js`) exposes skipped rebuilds |
| DMG build only after commit — never on a dirty tree | PreToolUse hook **denies** `electron:build` with uncommitted changes |
| Signing + notarization via keychain profile; verify with `codesign --verify --deep --strict` | Build fails unsigned; `doctor` checks the profile exists |
| Third-party license attribution shipped (`THIRD-PARTY-LICENSES.txt`) | `verify-ready --release` fails without it |
| Release checklist: clean-account install of the **previous** DMG → upload new DMG to Gumroad → update site version.json → **update banner appears in old version** → install new over it (banner clears, first-run works) → dogfood install over your real data | `verify-ready --release` blocks until acknowledged with `--ack-manual` (recorded per version) |
| Marketing site (version.json, changelog, listing) + release marketing drafts | Human judgment — release isn't complete until the site reflects it |

### Phase 8 — Maintenance & improvement

| Step | Enforced by |
|---|---|
| Dependency health: outdated, audit, Socket scan (`--socket`) | `policy health`; `check` flags every session once >30 days overdue |
| Tooling currency: model IDs, action versions, tool choices re-verified on schedule | `registry.json` verified-dates; `check`/`health` flag stale entries — then web-search, update, propagate |
| Dependabot PRs: minor/patch only, Socket-scanned before merge | `dependabot-reviewer` agent per branch; allowlist gate passes version-only bumps |
| GitHub issues triage; Cloudflare PRs/alerts for cloud apps | Human judgment + AI assistance |
| **Improvement loop:** when anything escapes — a user-reported bug, a regression, you catching yourself re-prompting — ask *"which check should have caught this?"* and add it to `policy.js`, a test, or a hook | Human judgment; the policy repo’s git history is the visible record that the control system learns |
| Cross-project learning: one project's fix becomes the shared template/standard | Template drift detection — every project self-reports divergence at session start |

---

## Hotfix lane

When a paying user is broken, this is the sanctioned minimum path — defined here so pressure never improvises one:

1. Fix on a branch. 2. `policy gates` — **gates always run, no exceptions.** 3. CHANGELOG + patch version bump. 4. Developer reviews and commits. 5. `verify-ready --release` (the manual checklist may compress to: clean-account banner check + dogfood install). 6. Ship DMG + site update. 7. **Mandatory retro:** which check should have caught this? Add it before closing the incident.

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

## Model strategy

Session model is the developer's choice (currently Claude Opus for Claude Code). Mechanical work is **structurally** delegated to Haiku via pinned agent definitions in `~/.claude/agents/` (`changelog-writer`, `readme-updater`, `dependabot-reviewer`) — the model choice lives in the agent file, not in anyone's memory. Current model IDs live in `registry.json` with verified dates; `health` flags them for re-verification on schedule.

## Transparency & traceability

**The authoritative evidence is machine-generated:** GitHub Actions CI logs (every push/PR — timestamped, third-party-hosted), git history (conventional commits, tags), CHANGELOG.md, PR review threads, `.policy/` markers, and the policy repo's own history (the control system's evolution). Specs and plans live in `.claude/specs/`, kept privately — shared on request. Local terminal output is working state, not evidence.

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
| 2.0 | 2026-07-13 | Enforcement-first rewrite: policy.js single entrypoint (doctor/check/scaffold/gates/verify-ready/health/mirror), hooks that block (session-start compliance injection, Stop changelog guard, PreToolUse DMG guard), every step now names its enforcement. Added: release checklist with update-banner verification, hotfix lane, improvement loop, verified-dates registry, template drift detection, file sync cloud-mount guard, keychain rules (notarytool profile vs safeStorage ban), attribution file requirement, migration/backup/downgrade-guard standards, haiku agent definitions, known-limitations section. Fixed: validate script mismatch, gitignore template conflicts (.claude/ vs specs; build/ vs Electron assets), Semgrep added to CI, home-dir-portable paths. |
| 1.5 | 2026-07-10 | Migrated local secret scanning from Gitleaks to Betterleaks; fixed duplicate step 40 numbering |
| 1.4 | 2026-07-07 | Gitleaks Homebrew-only; dependency allowlist with dual review; CodeRabbit in automated pipeline; shared scripts |
| 1.3 | 2026-06-28 | Model strategy, standing rules, marketing-site deploy step, expanded compliance check |
| 1.2 | 2026-06-28 | Code quality principles, cleanup pass |
| 1.1 | 2026-06-28 | Compliance check, deploy order (commit before DMG), automatic changelog/version/README, developer as committer |
| 1.0 | 2026-06-28 | Initial policy |
