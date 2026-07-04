# Build & Development Policy

**Version:** 1.4
**Last updated:** 2026-07-04

Single source of truth for how we build, maintain, and ship software. Every AI assistant (Claude, Codex, or other) and every human developer follows this workflow.

This document is tool-agnostic. Tool-specific configuration (Claude memory, Codex sandboxing, etc.) lives in the relevant tool's config files, not here. This is the process.

For detailed stack preferences, security rules, and file structure templates, see `project-standards.md`. This document defines the workflow those standards operate within.

---

## Machine Setup (one-time)

Install these before any development work. This section exists so a new machine can be fully configured from scratch.

### Runtime

- Node.js (LTS via nvm)
- npm (bundled with Node)
- PM2 (`npm install -g pm2`) -- local server process management
- Git

### Quality Tools

- TypeScript (`tsc` -- installed per-project via devDependencies)
- ESLint with `eslint-plugin-security` (per-project devDependency)
- Prettier with `prettier-plugin-tailwindcss` (per-project devDependency)
- html-validate (per-project devDependency) -- structural HTML validation (unclosed tags, mismatched nesting)
- Stylelint with `stylelint-config-standard` (per-project devDependency) -- CSS structural validation (duplicate selectors, deprecated properties)
- Semgrep (`brew install semgrep`) -- static application security testing
- Socket CLI (`npm install -g @socketsecurity/cli`) -- supply chain security
- Gitleaks (per-project devDependency) -- secret scanning (API keys, tokens, passwords in git history)
- license-checker (per-project devDependency) -- production dependency license compliance (fail on GPL/AGPL)
- Husky (per-project devDependency) -- git hooks (pre-commit runs validate + secrets)

### AI Tools

- Claude Code (primary -- complex builds, architecture, multi-file changes)
- Codex CLI (secondary -- code review, minor fixes, planning, cost-sensitive work)
- Other AI coding tools as needed

### Configuration

- `~/.npmrc`: set `min-release-age=1` (blocks packages published <24h ago)
- Socket wrapper: `socket wrapper on` (auto-scans every `npm install`)
- GitHub Actions: CI workflow for automated quality gates on push and PR

---

## Model Strategy

Not every task needs the most expensive model. When spawning agents or delegating sub-tasks, use the appropriate tier:

| Tier | Use for |
|---|---|
| Heavy | Architecture, complex multi-file changes, security review, planning |
| Standard | General implementation, code review, moderate fixes |
| Light | Simple lookups, formatting, repetitive single-file changes, search |

AI tools should apply this automatically when launching agents -- use the lightest model that can handle the task. When in doubt, use the standard tier, not the heavy tier.

---

## Standing Rules

These apply across the entire workflow, not to any single phase.

**Cross-project learning.** When a gap, fix, or improvement is discovered in one project (e.g. a missing `dependabot.yml`, a better script configuration, a security pattern), do not apply it only to that project. Update the shared standard so all projects benefit. One project's fix is every project's fix.

**App icons.** Every app must have its icon set up correctly. Electron apps: `build/icon.png` (512x512 PNG, electron-builder converts to `.icns`). Web apps: PWA icon set in `public/` with `manifest.json`. Generate from your brand asset.

**Marketing site dependency.** When any commercial or public app ships a new version, changes features, or updates its changelog, the marketing/portfolio site must also be updated: version info, changelog, app listing. An app release is not complete until the public-facing site reflects it.

---

## The Workflow

Forty-three steps across eight phases. Each step is numbered for reference. Steps marked **(mandatory)** must not be skipped. Steps marked with a tool name indicate which AI tools can perform that step.

### Phase 1 -- Context Loading

*Every session begins here, regardless of which AI tool is used.*

| # | Step | Mandatory | Who |
|---|---|---|---|
| 1 | Read context files at all levels: global, workspace, and project. Claude reads `CLAUDE.md`. Codex reads `AGENTS.md`. Both reference this policy and `project-standards.md`. | Yes | AI tool |
| 2 | Read `project-standards.md` for stack preferences, security rules, data safety patterns, and file structure templates. | Yes | AI tool |
| 3 | Read the target project's context file for its stack, architecture, key files, and known patterns. If no context file exists, create one before starting feature work. | Yes | AI tool |
| 4 | Load persistent context -- memory files, project notes, or equivalent for the tool in use. | Yes | AI tool |
| 5 | Activate quality tooling -- code review plugins, security scanners, supply chain tools. | Yes | AI tool |
| 6 | **Project compliance check** -- verify the project is inline with this build policy and `project-standards.md`. Check for and fix: missing `eslint-plugin-security`, missing `npm run sast` / `npm run quality` scripts, missing `.github/dependabot.yml`, missing Semgrep config, missing or outdated `CHANGELOG.md`, missing app icon, version in `package.json` matching last release, any other gaps. Fix them before starting feature work. | Yes | AI tool |

### Phase 2 -- Planning

*Required for major work. Optional for minor fixes, but intent must always be stated before execution.*

| # | Step | Mandatory | Who |
|---|---|---|---|
| 7 | Assess scope: is this major (new feature, architecture change, multi-file refactor) or minor (bug fix, config change, single-file edit)? | Yes | AI tool + developer |
| 8 | **Minor work:** state intent in one sentence -- what will change and why -- before starting. | Yes (minor) | AI tool |
| 9 | **Major work:** create a written plan -- what will change, which files are affected, the approach, and risks. Do not begin implementation until the developer approves the plan. | Yes (major) | AI tool |
| 10 | **New projects:** create a specification covering overview, features, architecture, data models, implementation phases, and success criteria. Review with developer before building. | Yes (new) | AI tool + developer |
| 11 | **Issue tracker (if applicable):** import implementation phases as epics with sub-issues. | Per-project | AI tool |

**Multi-tool usage:** Any AI tool can generate or review plans. Use a second tool for independent plan review when the change is complex or high-risk.

### Phase 3 -- Implementation

| # | Step | Mandatory | Who |
|---|---|---|---|
| 12 | Follow the approved spec or plan. Do not deviate without developer approval. | Yes | AI tool |
| 13 | Build in logical phases. Each phase should be testable before moving to the next. | Yes | AI tool |
| 14 | **Run `npm run validate` at every checkpoint** -- not just before commit. Checkpoints: (a) after any HTML structural change, (b) after any CSS/layout change, (c) before restarting the app (pm2/dev server), (d) after restarting the app -- run `npm run test:smoke` to verify the server is healthy and no endpoints return 500s, (e) before reporting a change as complete to the developer -- run `npm run test` (smoke + integration) to verify runtime behaviour. The quality gate is the verification step -- never skip it between editing and restarting. | Yes | AI tool |
| 15 | Before removing any constraint, guard, or validation: check the CHANGELOG. If it was introduced as a bug fix, it stays unless explicitly superseded by a new design. | Yes | AI tool |
| 16 | **Cleanup pass** -- before moving to quality gates, review the changes against the code quality principles in `project-standards.md`: remove dead code, eliminate duplication (3+ repeats), simplify over-engineered logic, ensure no feature creep or speculative code was introduced. Leave touched files cleaner than you found them. | Yes | AI tool |

**Multi-tool usage:** Secondary AI tools can execute implementation from approved plans, especially for well-scoped bug fixes, minor features, and repetitive changes. Keep complex, multi-file, or architectural work on the primary tool.

### Phase 4 -- Quality Gates

*Mandatory before every commit. Run in this order. Each gate must pass before proceeding to the next. If any gate fails, fix the issue and re-run from that gate.*

| # | Step | Command | Mandatory |
|---|---|---|---|
| 17 | Type-check | `tsc --noEmit` | Yes (TS projects) |
| 18 | Lint (includes security patterns) | `eslint . --max-warnings 0` | Yes |
| 18a | HTML validation | `html-validate *.html` | Yes (projects with HTML files) |
| 18b | CSS validation | `stylelint "styles/*.css"` | Yes (projects with CSS files) |
| 19 | Format check | `prettier --check .` | Yes |
| 20 | SAST scan | `semgrep scan --config auto` | Yes |
| 21 | Dependency audit | `npm audit --audit-level=high` | Yes |
| 21a | Secret scanning | `npm run secrets` | Yes |
| 21b | License compliance | `npm run licenses` | Yes |
| 22 | Build | `vite build` (or equivalent) | Yes |
| 23 | Smoke tests | `npm run test:smoke` | Yes (requires running server) |
| 24 | Integration tests | `npm run test:integration` | Yes (commercial/complex apps) |

Projects should wire steps 17--21b into a single command: `npm run quality`. Steps 22--24 run separately as they require a build or running server.

**Pre-commit enforcement:** Husky runs `npm run validate && npm run secrets` before every commit -- the fast checks (lint, HTML/CSS validation, format, type-check, secret scan). The full `npm run quality` pipeline (including SAST and npm audit) runs manually before commit or in CI.

**CI as safety net:** GitHub Actions runs a subset of the quality gates (steps 17--19, 21, 21b) on every push and PR, plus `gitleaks-action` for secret scanning. Tools that require local binaries (Semgrep SAST) and tests that need a running server (smoke/integration) run locally only. See `project-standards.md` for the exact CI template and what-runs-where table.

**Any AI tool or human can run these.** They are CLI commands.

### Testing Tiers

| Tier | What | When required | Script |
|---|---|---|---|
| 1 -- Smoke | Health check + hit every API endpoint, verify no 500s | All projects with a server | `npm run test:smoke` |
| 2 -- Integration | CRUD operations, data persistence, settings round-trip | Commercial apps, complex projects | `npm run test:integration` |
| 3 -- E2E | Playwright browser-driven UI flows | Commercial apps with complex UI | `npm run test:e2e` |

**Smoke tests are non-destructive** -- they only read from the live server. Integration tests run against an isolated server instance with a temporary data directory, so they cannot touch production data under any circumstances.

**Integration tests MUST be isolated from production data.** The test harness starts a separate server instance on a dedicated port with a temporary data directory. Production data is never read, modified, or at risk. This is a hard requirement to prevent accidental data loss.

### Phase 5 -- Review

| # | Step | Mandatory | Who |
|---|---|---|---|
| 25 | AI code review on all changes. Address all critical and high-severity findings. | Yes | Code review tool |
| 26 | Security review for changes touching auth, data handling, payment, CORS/CSP, or secret storage. | Yes (security areas) | AI tool + developer |
| 27 | Developer review -- verify the change locally, test in the UI, confirm it does what it should. | Yes | Developer |

**Multi-tool usage:** Use a second AI tool for independent code review alongside the primary reviewer. Different model = different blind spots. Recommended for high-risk changes.

### Phase 6 -- Commit & Version

*The AI performs these steps automatically for every change. The developer should never need to ask for changelog, version, or README updates -- they are part of the standard flow.*

| # | Step | Mandatory | Who |
|---|---|---|---|
| 28 | Update `CHANGELOG.md` following Keep a Changelog format. Every code change gets a changelog entry -- features, fixes, refactors, dependency updates. No exceptions. | Yes | AI tool |
| 29 | Update `README.md` if the change affects setup instructions, features, usage, configuration, or dependencies. | Yes (when relevant) | AI tool |
| 30 | Verify semver -- check last-released version before choosing a bump. Follow semver strictly. Bump the version in `package.json` (and any other version references) when preparing a release. | Yes (releases) | AI tool + developer |
| 31 | Conventional commit: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:` | Yes | Developer (AI prepares, human commits) |
| 32 | Feature branch: `your-username/{issue-id}-{short-description}` | Yes | AI tool or developer |
| 33 | Update issue tracker -- comment with implementation summary, update status. | Per-project | AI tool |

**Important:** The developer is the one who commits. The AI prepares the changes, runs quality gates, and presents the diff for review. The developer reviews and commits after confirming the changes are correct. This is the human gate.

### Phase 7 -- Deploy

*Deployment happens AFTER commit. Never build a release or deploy before the commit is clean and reviewed.*

**The correct order is: Quality gates (Phase 4) -> Review (Phase 5) -> Developer commits (Phase 6) -> Deploy (Phase 7). Never reverse this.**

| # | Step | Mandatory | Who |
|---|---|---|---|
| 34 | **Local apps:** `npm run build && pm2 restart {app-name}`. Never `npm run dev` for production local tools. | Yes (local) | AI tool or developer |
| 35 | **Stale build detection:** compare source mtimes against `.last-build`. Show warning banner if source files are newer than last build. | Automatic | System |
| 36 | **Electron apps:** `npm run electron:build` -- builds renderer, signs with Developer ID, notarizes with Apple, outputs DMG. Only run after all changes are committed and quality gates have passed. | Yes (Electron) | AI tool or developer |
| 37 | **Verify signing:** `codesign --verify --deep --strict` on the built `.app` bundle. | Yes (Electron) | AI tool or developer |
| 38 | **Distribution** (commercial apps) -- upload release to your distribution platform (e.g. app store, Gumroad). | Yes (commercial) | Developer |
| 39 | **Update marketing site** -- for any commercial or public app release: update version info, changelog, and listing/description if features changed. An app release is not complete until the public-facing site reflects it. | Yes (commercial/public) | AI tool + developer |

### Phase 8 -- Maintenance

*Ongoing. Run periodically across all active projects, not just when building features.*

| # | Step | Mandatory | Who |
|---|---|---|---|
| 40 | **Review GitHub issues** -- check open issues on each project repo. Triage: label, prioritise, close stale issues, and schedule work for valid bugs or feature requests. | Yes | Developer + AI tool |
| 41 | **Review Dependabot PRs** -- check each project for open Dependabot dependency update PRs. Dependabot is configured to only open PRs for minor and patch bumps (major version bumps are ignored -- handle those as planned work). For each PR: review the change on GitHub, pull the branch locally, run supply chain security scan, and merge only if clean. | Yes | Developer + AI tool |
| 42 | **Review infrastructure alerts** -- for cloud/SaaS projects deployed on a platform (e.g. Cloudflare, Vercel, AWS): check for automated PRs (platform updates) and review dashboard alerts (security, performance, billing). | Yes (cloud apps) | Developer + AI tool |
| 43 | **Dependency health check** -- run `npm audit` and supply chain scan across all active projects. Address any new high or critical vulnerabilities. | Yes | AI tool or developer |

**Multi-tool usage:** Maintenance triage is well-suited to secondary AI tools -- reviewing PRs, checking issue lists, and running scans are well-scoped tasks that don't require deep architectural context.

---

## Security Exclusions -- Always Human-Reviewed

These areas must never be modified by AI without explicit developer review and sign-off, regardless of which AI tool is used:

- Authentication or authorisation logic
- API key handling or secret storage
- User data deletion, purges, or bulk destructive operations
- Payment or billing logic
- CORS, CSP, or security header configuration
- Admin-area functionality
- Any change that could expose or compromise user data

This applies equally to all AI tools, current and future.

---

## Data Safety Standards

These apply to all local-first apps storing data as JSON files:

- **Atomic writes** -- write to `.tmp` then `fs.renameSync()`. Never `fs.writeFileSync()` directly on data files.
- **Field whitelisting** -- define `ALLOWED_FIELDS` per entity. Never spread `req.body` onto stored objects.
- **Multi-file consistency** -- read all data upfront, compute changes in memory, write all files. Never interleave reads and writes.
- **Cascade deletes** -- deleting a parent entity must clean up all child entities.
- **Supply chain protection** -- Socket CLI wraps `npm install`. `min-release-age=1` in `~/.npmrc` blocks packages published less than 24 hours ago.
- **Test isolation** -- integration tests must never run against production data. Use a separate server instance with a temporary data directory.

---

## Cross-LLM Configuration

Different AI tools read different context files. Each project should maintain the relevant files for any tool that will be used on it.

| File | Read by | When to create |
|---|---|---|
| `CLAUDE.md` | Claude Code | All projects using Claude |
| `AGENTS.md` | Codex, OpenCode | Projects where Codex/OpenCode will be used |
| `project-standards.md` | All tools (via reference) | Single copy, referenced by all projects |
| `BUILD-POLICY.md` | All tools (via reference) | This document |

### Keeping context files in sync

`CLAUDE.md` and `AGENTS.md` for the same project must contain the same project-specific information: stack, architecture, key files, patterns, gotchas. Tool-specific instructions go only in the relevant file.

When updating one, update the other. Both should reference `project-standards.md` and this build policy document.

---

## Compliance & Audit Trail

Every step in this workflow produces a traceable artifact. This matters for audits where you need to demonstrate build and maintenance processes.

| What | Artifact | Where |
|---|---|---|
| Planning | Spec or plan document | `.claude/specs/`, PR description, issue tracker |
| Quality gates | Pass/fail output | Terminal logs, CI output |
| Code review | AI review findings + resolutions | PR comments on GitHub |
| Security scan | Semgrep + npm audit + Socket results | Terminal logs, CI output |
| Change record | Conventional commit message | Git history |
| Version record | CHANGELOG entry | `CHANGELOG.md` in repo |
| README updates | Setup/feature/config changes | `README.md` in repo |
| Signing verification | codesign output | Build logs |
| Maintenance triage | Issue/PR review decisions | GitHub issue comments, PR merge history |
| Dependency updates | Dependabot PR + Socket scan result | GitHub PR history |

### Mandatory checklist (every change)

Before merging any change, confirm:

- [ ] Cleanup pass completed (step 16)
- [ ] Quality gates passed (steps 17--22)
- [ ] Tests passed -- smoke + integration (steps 23--24)
- [ ] Code review completed (step 25)
- [ ] Security review completed for security-sensitive areas (step 26)
- [ ] Developer verified the change locally (step 27)
- [ ] CHANGELOG updated (step 28)
- [ ] README updated if relevant (step 29)
- [ ] Conventional commit with clear message (step 31)

### Recommended checklist (significant changes)

- [ ] Written plan reviewed and approved before implementation (step 9)
- [ ] Independent code review from a second AI tool (step 25)
- [ ] Issue tracker updated with implementation summary (step 33)

---

## When to Use Which Tool

This is guidance, not a hard rule. The developer chooses based on the task, cost, and compliance requirements.

| Task | Primary | Secondary |
|---|---|---|
| Complex builds, architecture, multi-file features | Claude | -- |
| Bug fixes (well-scoped, <4 files) | Claude or Codex | -- |
| Code review | AI review tool | Second AI tool (second opinion) |
| Planning and scope assessment | Claude | Codex or other |
| Security review | Claude + Semgrep | -- |
| Open-source project work (cost-sensitive) | Codex or other | Claude (for complex parts) |
| Repetitive changes across files | Codex | Claude |
| Quality gates (lint, type-check, SAST, audit) | CLI commands (any tool) | -- |
| Maintenance (issue triage, Dependabot PRs) | Codex or other | Claude |

---

## Version History

| Version | Date | Changes |
|---|---|---|
| 1.4 | 2026-07-04 | Added Stylelint CSS validation, testing tiers (smoke + integration), test isolation requirement, quality gate checkpoints during implementation (step 14), renumbered steps for consistency |
| 1.3 | 2026-06-28 | Added model strategy, standing rules (cross-project learning, app icons, marketing site dependency), expanded compliance check |
| 1.2 | 2026-06-28 | Added code quality principles, cleanup pass (step 16) before quality gates |
| 1.1 | 2026-06-28 | Added project compliance check (step 6), corrected deploy order (commit before build), made changelog/version/README updates automatic, clarified developer as committer |
| 1.0 | 2026-06-28 | Initial policy -- full workflow, Semgrep and eslint-plugin-security, planning step, multi-tool support, compliance section, cross-LLM configuration, maintenance phase |
