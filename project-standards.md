# Project Standards

**Version:** 2.2
**Last updated:** 2026-07-16

Reference material for consistent project setup and development — stack choices, security rules, and file templates. The workflow these standards operate within is `BUILD-POLICY.md`; the machinery that enforces them is `scripts/policy.js`. Nothing in this document needs to be memorised to stay compliant — `policy check` verifies the checkable parts.

**Paths:** always write paths with `~` (home directories differ across machines: the same sync folder lives under different usernames). Paths must resolve to the local sync folder — `policy.js` refuses to run on the cloud mount (`/Volumes/...`).

---

## How to Start a New Project

### Step 1: User Setup
```bash
# Create project folder
mkdir my-new-app
cd my-new-app

# Create .claude folder for specs
mkdir -p .claude/specs

# Optional: init git
git init
```

### Step 2: Start Claude Code
```bash
claude
```

### Step 3: First Prompt to Claude Code

The session-start hook already runs the compliance check. Then:

```
Run: node ../build-policy/scripts/policy.js scaffold

I want to build [describe your app concept here].

Create a spec in .claude/specs/ following project-standards.md, then we'll review before building.
```

### Step 4: Review Spec → Build → Iterate
1. Claude Code creates spec in `.claude/specs/{project}-spec.md`
2. Review and refine spec together
3. Claude Code builds entire app per spec
4. Test and iterate

---

## Pre-Setup Checklist (User Does)

Before starting Claude Code:
- [ ] Create project folder with `.claude/specs/` subfolder
- [ ] Create GitHub repo (public or private as needed)
- [ ] **Ask user**: use Linear for this project? (not required for personal/small tools)
- [ ] Have project concept ready to describe

---

## Specification First

**Always start with a spec.** Create `.claude/specs/{project}-spec.md` before building.

### Spec Template Structure

```markdown
# {Project Name} - Specification

**Version:** 1.0
**Date:** {date}
**Status:** Ready for Implementation

---

## Project Overview
What we're building and why. Core value proposition.

## Feature Requirements
Detailed features with user experience examples.
Show CLI/UI interactions as code blocks.

## Technical Architecture

### Stack
- Frontend: React + TypeScript + Vite + Tailwind (or Python CLI with Typer + Rich)
- Backend: Node.js + Express (ES modules) or Python
- AI: Anthropic Claude API
- Data: Local JSON files in `local_data/`

### Project Structure
```
project/
├── src/ or {module}/
├── local_data/        # Gitignored, user data
├── .claude/
│   └── specs/         # Specifications
├── .env               # Secrets (gitignored)
├── CHANGELOG.md
└── package.json or requirements.txt
```

### Data Models
JSON schemas or SQL schemas for all stored data.

### API/AI Integration
- Endpoints needed
- Claude prompts with expected JSON responses
- Cost considerations (prefer Haiku 4.5)

### Third-Party Integrations (if applicable)
- Auth provider and flow
- Payment provider and flow
- Other external services

### Storage & Limits (if applicable)
- Upload size limits
- Account storage caps
- Media management (list, delete)

## Build Guidelines
- Linter, formatter, type-checker, security checker config
- CodeRabbit review requirements
- Git workflow for this project

## Implementation Phases
Break into logical phases. Each phase should be testable.
DO NOT include time estimates - just logical groupings.
Document as Linear epics with sub-issues using issue-tracker-cli.

## Success Criteria
Checklist of what "done" looks like.
```

### Spec Principles
- Be specific: Show exact CLI commands, UI flows, JSON structures
- Include error states and edge cases
- Define data models upfront
- List all Claude prompts with expected response formats
- No time estimates in specs

---

## Build Approach

**Build the entire app in one session, then iterate.**

1. Read the spec fully before starting
2. Build all core functionality in sequence
3. Run lint/type-check/format throughout
4. Test each phase before moving to next
5. Polish and document at the end

---

## Stack Preferences

### React/TypeScript Projects (Local)
- Vite + React + TypeScript + Tailwind CSS
- Express backend (ES modules)
- Zustand for state management
- ESLint + Prettier
- PM2 for local server management

### React/TypeScript Projects (Cloud SaaS)
- Vite + React + TypeScript + Tailwind CSS
- Cloudflare Pages (frontend hosting)
- Cloudflare Workers + Hono (API)
- Cloudflare D1 (SQLite database)
- Cloudflare R2 (file/image storage)
- Zustand for state management
- ESLint + Prettier

### Electron Desktop Apps (macOS)
- Vite + React + TypeScript + Tailwind CSS (renderer)
- Express backend bundled in the app (ES modules, serves dist/ + /api)
- Electron main process: find free port → start Express → load window from localhost
- **Dynamic port (mandatory):** The Electron main process MUST use `findFreePort()` (bind to port 0, read the assigned port, close, then pass it to Express). NEVER hardcode a port — it will collide with the PM2 dev instance or any other local server, silently connecting to the wrong process and potentially corrupting data. Reference: `a-reference-app/electron/main.js`.
- Zustand for state management
- `contextIsolation: true`, `nodeIntegration: false`
- **PDF export:** use **pdfmake** (pure JS, no Chromium dependency). Do NOT use Puppeteer — it bundles a ~150MB Chromium binary unnecessarily since Electron already IS Chromium.
- **Secret storage:** AES-256-CBC with a machine-derived key (`SHA256(appname:hostname:username)`). Do NOT use Electron `safeStorage` — its encrypted values go stale across app re-signs/updates (see a-reference-app `server/ai.js` `isStaleSafeStorageKey` for the migration that moved off it).
- **Native modules** (e.g. better-sqlite3): add `"postinstall": "npx @electron/rebuild -f -w <module>"` and `"asarUnpack": ["**/*.node"]` in electron-builder config.
- **No in-app license gate** — Gumroad download is the gate (matches all shipping apps).
- **Version check:** fetch `yourdomain.com/<app>/version.json` on launch with a cache-busting param (`?t=${Date.now()}`) so CDN caching can't hide a release; show the update banner on a **simple version mismatch** (`site.version !== APP_VERSION`), not a semver "newer than" comparison. The mismatch check is deliberate (decided 2026-07-15): it needs no comparison function, and it makes banner verification self-testing at every release — install the new DMG while the site still lists the old version and the banner MUST appear (same code path a user's old app hits); update the site and it MUST clear. Cosmetic trade-off accepted: during the upload window the developer's own new build shows a banner naming the older site version — nobody else ever sees that state. The live banner is verified twice per release via the release checklist (`verify-ready --release`). Apps still on a semver comparison (e.g. a-reference-app): migrate to the mismatch check when next touched.
- **Data safety:** schema version + migration-on-load + pre-migration backups + downgrade guard are mandatory — see § Data Migration, Backups & Downgrade Guard.
- **Diagnostics:** structured local logging + "Export diagnostics" — see § Diagnostics Logging.
- **Privacy disclosure:** BYOK apps send user content to the configured AI provider — state this consistently in the app's settings UI, README/listing, and the site's terms page. No commercial release without the disclosure in place.

**DMG Build, Code Signing & Notarization:**

Prerequisites (one-time per machine):
- Apple Developer account with a "Developer ID Application" certificate installed in Keychain
- App-specific password generated at appleid.apple.com → Security → App-Specific Passwords
- Store it in the Keychain once — the password must exist in **no file**:
  ```bash
  xcrun notarytool store-credentials yourcompany \
    --apple-id your@apple.id --team-id TEAMID --password xxxx-xxxx-xxxx-xxxx
  ```
  (`policy doctor` verifies the profile exists. After rotating the app-specific password, re-run this command.)

`.env` file (gitignored) — one non-secret line:
```
APPLE_KEYCHAIN_PROFILE=yourcompany
```

Legacy projects using `APPLE_ID`/`APPLE_TEAM_ID`/`APPLE_APP_SPECIFIC_PASSWORD` in `.env` still build, but migrate them to the keychain profile when touched — a plaintext password in `.env` is one `cat` away from a leak.

**Keychain rules — two different things, don't conflate:** the *dev machine's* Keychain is exactly where notarization credentials belong (above). *Shipped apps* must never store user secrets via Electron `safeStorage`/Keychain — see Secret storage below.

`package.json` electron-builder config:
```json
{
  "build": {
    "appId": "com.yourcompany.<appname>",
    "productName": "App Name",
    "icon": "build/icon.png",
    "mac": {
      "category": "public.app-category.<category>",
      "target": [{ "target": "dmg", "arch": ["universal"] }],
      "identity": "Your Name (TEAMID)",
      "hardenedRuntime": true,
      "entitlements": "build/entitlements.mac.plist",
      "entitlementsInherit": "build/entitlements.mac.plist",
      "notarize": true
    },
    "files": ["electron/**/*", "server/**/*", "dist/**/*", "!local_data/**", "!**/*.map"],
    "directories": { "output": "release" },
    "asar": true,
    "asarUnpack": ["**/*.node"]
  }
}
```

`build/entitlements.mac.plist` (standard for all apps):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
</dict>
</plist>
```

Build script: `"electron:build": "npm run build && export $(grep -v '^#' .env | grep APPLE | xargs) && electron-builder --mac"`

Run: `npm run electron:build` — builds the renderer, signs, notarizes, outputs DMG to `release/`.

Icon: `build/icon.png` (512x512 PNG). electron-builder converts to `.icns` automatically.

### Third-Party Service Preferences
- **Auth:** Clerk (free tier up to 10k MAU, React SDK, JWT)
- **Payments:** LemonSqueezy (merchant of record, handles global tax, SaaS subscriptions)
- **Fonts:** Google Fonts API

### Python Projects
- Typer + Rich for CLI
- Black + Ruff for formatting/linting
- python-dotenv for env vars

### AI Integration
- Prefer the fast tier (Haiku) for app AI features; use the smart tier only when the task requires it
- Implement caching to reduce API costs
- Rate limiting on expensive endpoints
- **Model IDs — the source of truth is `build-policy/registry.json`.** Never invent IDs; copy from the registry (which mirrors the shipping apps). Each registry entry carries a `verified` date; `policy health`/`check` flag entries past their review window — when flagged, web-search the current models, update the registry and every shipping app consistently. Don't ship stale IDs.

---

## Mobile Access Strategy (local-first apps)

Apps stay local-first; mobile access must never route data through our servers. The scope rule that keeps sync tractable for a solo developer: **capture and reference, not editing parity.**

- **Append-only capture** (e.g. journal entries from a phone): new UUID+timestamped records merged into the Mac data — conflict-free by construction.
- **Read-only reference** (e.g. client/invoice lookup on the road): the Mac is the only writer; the phone gets a snapshot — no sync conflicts exist.
- Full bidirectional editing on mobile is out of scope until something forces it; that's where all the conflict complexity and cost lives.

**The ladder (climb only on proven demand):**
1. **No-app rungs first** — iOS Shortcut writing to an iCloud Drive inbox file the Mac app imports (capture), or an encrypted self-contained HTML snapshot exported to iCloud Drive (reference). Days of work, tests demand. Reference specs: `a-reference-app/.claude/specs/mobile-capture-spec.md`, `a-reference-app/.claude/specs/mobile-snapshot-spec.md`.
2. **Free App Store companion** per app — iCloud Drive file sync via the user's own iCloud (Developer ID Mac apps cannot use CloudKit; plain files in iCloud Drive are the mechanism), QR-code pairing for E2E encryption, capture-and-reference scope. No unlock key: the companion is free and useless without the Mac app's data — the Gumroad download stays the gate, which also avoids App Store external-purchase review friction.
3. **Hosted sync service — never by default.** It inverts the privacy positioning and creates data liability.

**Rules for anything synced:** every synced record carries `schemaVersion` and `updatedAt`; the downgrade guard applies across devices (a phone snapshot is another "app version" reading the data); iCloud can sync files mid-write, so all readers must tolerate partial/garbled files without data loss; snapshots display their export timestamp.

---

## Code Quality

### Principles

These apply to all code changes, in every project, by every AI tool and human.

**Simplicity first.** Prefer the obvious approach. If you need a comment to explain how something works, it's too clever. A straightforward solution that a reader can follow in one pass beats a compact one that requires mental gymnastics.

**DRY with judgment.** Extract when a pattern repeats three or more times. Two similar blocks are not duplication — they're coincidence. Don't create abstractions for hypothetical future reuse. Three similar lines is better than a premature helper.

**Remove dead code.** Delete unused imports, functions, variables, components, and files. Don't comment code out — git has the history. Commented-out code rots, confuses readers, and hides real logic.

**Small and focused.** Each function does one thing. Each file owns one concept. A function that needs scrolling is too long — break it up. A file over ~300 lines should probably be split. A component that handles its own data fetching, state, layout, and business logic should be decomposed.

**No feature creep.** A bug fix is a bug fix — don't refactor the surrounding code or add features in the same change. A feature is a feature — don't fix unrelated bugs in the same PR. Keep changes focused and reviewable.

**Clean as you go.** When touching a file, clean up what you find: unused imports, dead variables, stale comments, inconsistent formatting. Leave the file better than you found it, but don't rewrite it.

**No speculative code.** Don't add feature flags, config options, extension points, or abstractions for requirements that don't exist yet. Build for what's needed now. When the future requirement arrives, refactor then — it'll be a better design because you'll know the actual shape of the problem.

### JavaScript/TypeScript
```bash
npm run lint        # ESLint (--max-warnings 0)
npm run format      # Prettier
npm run type-check  # tsc --noEmit (strict: true)
npm run build       # Full build
npm run security    # npm audit --audit-level=high
npm run sast        # semgrep scan --config auto --error (with exclusions)
```

**Semgrep rule exclusions** (triaged 2026-07-13, all false positives in local-data Express apps):
- `path-join-resolve-traversal` — fires on every `path.join()` with a variable; all route params validated via `validateParam` middleware (`^[a-zA-Z0-9_-]+$`); internal server paths don't involve user input
- `express-path-join-resolve-traversal` — Express variant of the same; same validation applies
- `express-res-sendfile` — can't detect validation guards (`isValidSafetyName` checks `basename === filename` + prefix/suffix) before `sendFile()`
- `remote-property-injection` — can't distinguish static allowlist iteration (`for (const key of allowed)`) from user-controlled bracket keys

**Required ESLint plugins:**
- `@typescript-eslint` — TypeScript-aware rules
- `eslint-plugin-react-hooks` — React Hooks rules
- `eslint-plugin-import` — Import ordering
- `eslint-plugin-security` — Security anti-pattern detection (eval, non-literal require, regex DoS)

**Required Prettier plugins:**
- `prettier-plugin-tailwindcss` — Tailwind class sorting

**Required HTML validation (projects with HTML files):**
- `html-validate` — structural HTML validation (unclosed tags, mismatched nesting)
- Config: extend `html-validate:recommended`, suppress stylistic rules (`void-style`, `no-implicit-button-type`, `no-inline-style`, `doctype-style`)
- Wire into validate/quality scripts as `lint:html`

**Required CSS validation (projects with CSS files):**
- `stylelint` + `stylelint-config-standard` — catches duplicate selectors, deprecated properties, invalid values
- Config: extend `stylelint-config-standard`, suppress stylistic rules (see a-reference-app `.stylelintrc.json` for reference)
- Wire into validate/quality scripts as `lint:css`

**Required secret scanning:**
- `betterleaks` — detects API keys, tokens, passwords, and other secrets in git history (official successor to Gitleaks, by the same author)
- **Homebrew only** (`brew install betterleaks`). Do not install via npm — betterleaks is also not distributed via npm, install via Homebrew only. In CI, use `gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7 # v2.3.9` (pinned to full commit SHA — third-party actions must be SHA-pinned against supply-chain attacks) until a Betterleaks action is available.
- Wire into quality script as `npm run secrets`

**Required license compliance:**
- `license-checker` — validates that production dependencies use approved licenses (GPL/AGPL must fail)
- Wire into quality script as `npm run licenses`

**Required git hooks:**
- `husky` — pre-commit runs `node ../build-policy/scripts/policy.js gates --fast` (template: `build-policy/templates/pre-commit`; `policy scaffold` installs it)
- Wire into package.json with `"prepare": "husky"` script
- The fast subset is type-check, lint, html-validate, stylelint, format check, secret scan, dependency allowlist. The full pipeline (SAST, audit, licenses, CodeRabbit, build, tests) runs via `policy gates` before presenting work, and in CI

**TypeScript strict settings:**
- `strict: true` in `tsconfig.json`
- `noUncheckedIndexedAccess: true`
- No `any` types — use `unknown` and narrow

**Standard package.json scripts** (`policy scaffold` adds missing ones — adjust the HTML/CSS globs to where the project actually keeps those files):
```json
{
  "lint": "eslint . --max-warnings 0",
  "lint:fix": "eslint . --fix",
  "lint:html": "html-validate *.html",
  "lint:css": "stylelint \"styles/*.css\"",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "type-check": "tsc --noEmit",
  "security": "npm audit --audit-level=high",
  "sast": "semgrep scan --config auto --error --quiet --exclude-rule javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal --exclude-rule javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal --exclude-rule javascript.express.security.audit.express-res-sendfile.express-res-sendfile --exclude-rule javascript.express.security.audit.remote-property-injection.remote-property-injection",
  "secrets": "betterleaks git . -v",
  "licenses": "license-checker --production --failOn 'GPL-2.0;GPL-3.0;AGPL-1.0;AGPL-3.0' --summary",
  "licenses:file": "license-checker --production > THIRD-PARTY-LICENSES.txt",
  "deps:check": "node ../build-policy/scripts/check-allowlist.js .",
  "deps:verify": "node ../build-policy/scripts/verify-package.js",
  "review": "coderabbit review --agent",
  "validate": "npm run lint && npm run lint:html && npm run lint:css && npm run format:check && npm run type-check",
  "quality": "npm run validate && npm run sast && npm run security && npm run secrets && npm run licenses && npm run deps:check && npm run review",
  "test:smoke": "node tests/smoke.js",
  "test:integration": "node tests/harness.js integration",
  "test": "npm run test:smoke && npm run test:integration",
  "prepare": "husky",
  "build": "tsc --noEmit && vite build"
}
```

`validate` is the canonical fast-check name (husky and BUILD-POLICY reference it). Projects that historically used `check` should keep it as an alias: `"check": "npm run validate"`.

### Python
```bash
python3 -m black .              # Format
python3 -m ruff check . --fix   # Lint + fix
python3 -m ruff check .         # Verify clean
```

**Run before every commit. No exceptions.**

### Regression Prevention

Before modifying or removing any code that enforces a constraint, cap, guard, or validation:

1. **Check the CHANGELOG** — search for entries that introduced the code as a bug fix. If it was a fix, it stays unless explicitly superseded by a new design.
2. **Trace root causes precisely** — don't remove safeguards from unrelated code paths just because they touch the same data. Fix the actual cause, not a nearby constraint.
3. **When reviewing existing changes** — if the user asks whether prior edits are still needed, review each change individually against the changelog. Don't blanket-approve.
4. **Regressions are serious** — every regression costs a rebuild, retest, and re-deploy cycle. Regression rate is a key quality metric.

### Code Reviews

- All PRs reviewed by **CodeRabbit** before merge
- Address all critical and high-severity findings
- Use `coderabbit:review` skill for on-demand reviews during development
- **Socket** scans dependencies for supply chain risks (separate from code review — see Security section)

---

## Git Workflow

- Feature branches: `yourname/{issue-id}-{short-description}`
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
- PR per feature/issue
- CodeRabbit review required on all PRs
- Comment on Linear issue with implementation summary before PR

---

## Linear Workflow (optional — confirm with user per project)

Use `issue-tracker-cli` for all Linear issue management. Run `issue-tracker-cli --help` for full reference.

### Issue Structure
- **Epics** = implementation phases (labelled `epic`)
- **Sub-issues** = individual tasks within each phase
- Import phases as epics with children using `issue-tracker-cli import issues.json`

### Common Commands
```bash
# List open issues for a project
issue-tracker-cli list issues TC --project "My Project"

# List current cycle issues
issue-tracker-cli list issues TC --cycle current

# View issue details
issue-tracker-cli get TC-109 --children

# Update status and comment
issue-tracker-cli status TC-109 "In Progress"
issue-tracker-cli comment TC-109 "Implementation summary here"
```

---

## Versioning

- Semantic versioning: MAJOR.MINOR.PATCH
- Update `CHANGELOG.md` with each release
- Tag releases in git

### CHANGELOG Format
```markdown
# Changelog

## [1.1.0] - 2025-01-15
### Added
- New feature X

### Fixed
- Bug in Y

## [1.0.0] - 2025-01-01
- Initial release
```

---

## File Structure

### React Projects (Local)
```
project/
├── src/
│   ├── components/
│   ├── hooks/
│   ├── services/
│   ├── stores/            # Zustand stores
│   ├── types/
│   └── utils/
├── server/
│   ├── src/
│   └── index.js
├── public/
├── .claude/
│   └── specs/
├── .env
├── .gitignore
├── CHANGELOG.md
├── package.json
└── README.md
```

### React Projects (Cloud SaaS — Cloudflare)
```
project/
├── src/                   # Frontend (Cloudflare Pages)
│   ├── components/
│   ├── hooks/
│   ├── services/
│   ├── stores/            # Zustand stores
│   ├── types/
│   └── utils/
├── worker/                # Backend (Cloudflare Worker)
│   ├── src/
│   │   ├── routes/
│   │   ├── middleware/
│   │   └── db/
│   │       └── schema.sql
│   └── wrangler.toml
├── public/
├── .claude/
│   └── specs/
├── .env
├── .gitignore
├── CHANGELOG.md
├── package.json
└── README.md
```

### Python Projects
```
project/
├── {module}/
│   ├── commands/
│   ├── models/
│   ├── utils/
│   └── ai/
├── local_data/
├── .claude/
│   └── specs/
├── .env
├── .gitignore
├── CHANGELOG.md
├── requirements.txt
└── README.md
```

---

## .gitignore Essentials

Canonical template: `build-policy/templates/gitignore` (`policy scaffold` installs it). Key rules:

- **Ignore all AI context files** (`.claude/`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`) — they're local-only runtime context, synced between machines by file sync, and must never reach GitHub (some repos are public). Specs live in `.claude/specs/`, so they're private by the same rule.
- **Do NOT ignore `build/`** — for Electron apps it holds committed source assets (`icon.png`, `entitlements.mac.plist`). Build *outputs* are `dist/` and `release/`, which are ignored.
- Ignore `.policy/` (local gate markers/state), `.env`, `local_data/`, `*.log`, `node_modules/`.
- Before making any existing repo public: run betterleaks over full history and confirm context files were never committed — gitignore does not scrub history.

---

## Environment & Secrets

- All secrets in `.env` (never commit)
- Document required env vars in README
- Check for required vars on startup

---

## Documentation

Keep minimal:
- `README.md` - Setup instructions only
- `CHANGELOG.md` - Version history
- Code comments - Only where logic isn't self-evident
- Specs in `.claude/specs/` - Implementation reference

**No excessive documentation files.**

---

## Security

- No secrets in code
- Validate all user input (use Zod schemas on API endpoints)
- Rate limiting on public/expensive endpoints
- Rate limiting + lockout on auth endpoints (e.g. 5 failed attempts)
- CORS restricted to app domain (not wildcard), regex must be anchored (e.g. `/^https?:\/\/localhost(:\d+)?$/` not `/localhost/`)
- Content Security Policy headers on cloud apps
- Return generic error messages to clients — log details server-side only (no stack traces, DB names, or internals in responses)
- `npm audit` / security check required before every commit
- No high or critical vulnerabilities allowed

### Data Safety (Local JSON Apps)

These patterns apply to all local-first apps that store data as JSON files. They address recurring CodeRabbit findings.

**Atomic writes everywhere:**
- ALL file writes must use `atomicWrite()` (write `.tmp` then `fs.renameSync`) — never use `fs.writeFileSync()` directly for data files. This includes labels, indexes, metadata, and auxiliary files — not just entity data.

**Field whitelisting on API endpoints:**
- Never spread `req.body` directly onto stored objects (`{ ...defaults, ...req.body }`). This allows arbitrary fields to pollute JSON data.
- Define an `ALLOWED_FIELDS` array per entity and use a `pick(obj, fields)` helper to filter `req.body` before spreading.
- Protected fields (`id`, `createdAt`, `updatedAt`) must always be set explicitly after the spread.

**Multi-file operations:**
- When an operation modifies multiple JSON files (e.g., trashing a client removes from clients, jobs, tasks, activities, reminders), read all data upfront in one batch, compute all changes in memory, then write all files. Never interleave reads and writes — a crash between writes leaves data inconsistent.

**Cascade deletes:**
- When deleting a parent entity, always clean up child entities (e.g., deleting a job must also remove its tasks from `tasks.json`). Orphaned records waste space and appear in backups.

### Data Migration, Backups & Downgrade Guard (commercial/Electron apps)

User data outlives any single app version. Data loss on upgrade is the worst possible outcome for a paid app — worse than any bug the gates catch.

**Schema version:**
- Every data file carries a `schemaVersion` field. The app knows its current schema version as a constant.

**Migration-on-load:**
- On startup, if stored `schemaVersion` < app's version: run migrations sequentially (v1→v2→v3), each a small pure function. Never migrate in place without a backup first.

**Pre-migration backups (automatic):**
- Before any migration runs, copy the data files to `local_data/backups/<timestamp>-v<oldVersion>/`. Keep a rotation (e.g. last 10). This also gives users regular restore points — surface a "Restore from backup" path in the app where practical.

**Downgrade guard:**
- If stored `schemaVersion` > app's version (user rolled back, or developer launched an old build over new data): **refuse to write, explain clearly, and exit gracefully.** Never let an old version silently mangle newer data. This protects the developer's own dogfood installs and the release banner test.

**Upgrade-path test (integration tier):**
- Keep a fixture of the *previous* release's data files in `tests/fixtures/`. The integration suite loads it and asserts the app migrates and reads it correctly. A release that can't load its predecessor's data must not ship.

### Diagnostics Logging (shipped apps)

Once a DMG is on a user's machine you are blind — unless the app logs.

- Structured local logging (timestamped, levelled) to the app's log directory; rotate, cap size.
- Log operational events and errors — **never** user content, API keys, or request/response bodies.
- An "Export diagnostics" menu item that zips the logs for the user to email support. This is the privacy-respecting alternative to crash telemetry (which stays a deliberate per-app product decision).

### Third-Party License Attribution (shipped apps)

`npm run licenses` validates license compatibility; attribution is the other half of the obligation:
- `npm run licenses:file` generates `THIRD-PARTY-LICENSES.txt`; regenerate when dependencies change and include it in the app bundle (add to electron-builder `files`).
- `verify-ready --release` fails for Electron apps without it.

### Supply Chain Security (Socket)

Socket CLI (`@socketsecurity/cli`) is installed globally with the npm wrapper enabled. Every `npm install` is automatically scanned for malicious packages, typosquatting, and supply chain risks.

**Package verification — before every install:**
Before installing any npm package, verify it is the genuine upstream package:
- Check the publisher/org on npmjs.com matches the real project maintainers
- Check the repository URL points to the official project repo
- Check download count and version history — a single v1.0.0 with no updates is a red flag
- Check the package description and README match the tool's actual purpose
- If a tool is primarily distributed outside npm (Homebrew, GitHub releases, Go binary), do not assume an npm package with the same name is an official wrapper — verify explicitly
- Socket's automatic scanning catches malicious packages but does not catch name-squatted packages that are merely useless or misleading

**When to be extra cautious:**
- Starting a new project (`npm install` pulls many packages at once)
- Swapping out dependencies when something doesn't work
- Running `npm audit fix` (can upgrade into a freshly compromised version)
- Merging Dependabot PRs — always run through the flow below first

**Dependabot configuration (standard for all projects):**

Every project with a GitHub repo should have `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    ignore:
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
    open-pull-requests-limit: 10
```

Major version bumps are ignored — they often include breaking changes that require manual migration and testing. Handle major upgrades deliberately as planned work, not via automated PRs.

**Dependabot PR Flow (minor and patch only, with Socket):**
1. Review the Dependabot PR on GitHub — confirm it is a minor or patch bump
2. `git fetch origin` to pull the branch locally
3. `git checkout <dependabot-branch-name>`
4. `socket scan create your-org .` to scan for supply chain risks
5. `npm install && npm run quality` to verify build, lint, types, SAST, and security all pass
6. If clean, merge on GitHub
7. `git checkout main && git pull` to return to main

**Commands:**
```bash
socket scan create your-org .  # Scan current project dependencies (org + path)
socket npm install <pkg>    # Install with Socket scanning (automatic if wrapper is on)
socket fix                  # Fix CVEs in dependencies
socket wrapper on/off       # Enable/disable automatic npm wrapping
```

**Minimum Release Age:**
`min-release-age=1` is set globally in `~/.npmrc`. npm will refuse to resolve any package version published less than 24 hours ago. This filters out the riskiest window for supply chain attacks — most malicious packages are detected and removed within hours of publication.

**Setup:** Free tier (1,000 scans/month). Run `socket login` to authenticate with your API token.

### Dependency Allowlist

Every project maintains an `allowed-packages.json` in its root. Only packages on this list may appear in `package.json`. The allowlist check runs as part of `npm run quality` — any unapproved package fails the gate.

**Allowlist format:**
```json
{
  "express": {
    "repo": "https://github.com/expressjs/express",
    "publisher": "wesleytodd",
    "weeklyDownloads": 106634055,
    "versions": 288,
    "verified": "2026-07-07"
  }
}
```

**Adding a new package:**
1. Run `npm run deps:verify <package-name>` — queries npm registry and Socket for metadata, flags risks
2. A security-focused agent independently reviews the verification output
3. The primary agent reviews the security agent's findings and the raw data
4. Only if both reviewers approve, add the entry to `allowed-packages.json`
5. Both the verification output and the allowlist diff are visible to the developer at commit time

**Dual-reviewer requirement:** No package may be added to the allowlist by a single reviewer. The verification script provides the data; a security agent and the primary agent must independently confirm the package is legitimate. This catches name-squatted, abandoned, or unnecessary packages that automated scanners miss.

**Scripts (shared in `build-policy/scripts/`):**
```bash
node ../build-policy/scripts/verify-package.js <name>   # Verify a package before adding
node ../build-policy/scripts/check-allowlist.js .        # Check all deps against allowlist
node ../build-policy/scripts/bootstrap-allowlist.js .    # Generate initial allowlist from package.json
```

**Standard package.json scripts:**
```json
{
  "deps:check": "node ../build-policy/scripts/check-allowlist.js .",
  "deps:verify": "node ../build-policy/scripts/verify-package.js"
}
```

Wire `deps:check` into `npm run quality`. Dependabot PRs only bump versions of already-approved packages, so they pass automatically.

**Bootstrap:** For existing projects, run the bootstrap script to generate the initial allowlist from current dependencies. Review the output for any flagged packages before committing.

### GitHub Actions CI

All projects with a GitHub repo have `.github/workflows/ci.yml`. The canonical template is `build-policy/templates/ci.yml` — `policy scaffold` installs it and `policy check` flags drift from it. **CI is the audit evidence layer**: timestamped, third-party-hosted proof that no code reached main without passing the gates.

**What runs where:**

| Check | Local (`policy gates`) | CI (GitHub Actions) |
|---|---|---|
| Lint, format, type-check | Yes | Yes |
| HTML/CSS validation | Yes | Yes (`--if-present`) |
| SAST (Semgrep) | Yes (brew install) | Yes (pip install in workflow) |
| npm audit, license compliance | Yes | Yes |
| Secret scanning | Yes (betterleaks CLI) | Yes (gitleaks-action, full history) |
| Dependency allowlist | Yes | No (`build-policy/scripts` isn't in the repo — local-only by design) |
| CodeRabbit review | Yes | Via PR integration |
| Smoke/integration tests | Yes (needs running server) | No (needs server lifecycle) |

GitHub Actions versions are tracked in `registry.json` with verified dates — pin them to commit SHAs at the next scheduled review.

### File Uploads (when applicable)
- Per-file size limit (e.g. 5MB)
- Per-account storage cap (e.g. 100MB)
- Validate MIME type server-side (not just file extension)
- Track storage usage per user in database

### API & Auth
- Never rely on frontend route guards for access control — protect every route server-side
- Apply auth middleware at the router level (not per-route) to prevent gaps
- Validate resource ownership server-side on every request (prevent IDOR — never trust client-supplied IDs alone)
- Store auth tokens in httpOnly cookies, not localStorage (localStorage is readable by any script via XSS)
- Set expiry on all JWTs — implement refresh token rotation for SaaS apps

### SaaS / Cloud Apps
- Auth token (JWT) verification on all API routes
- Webhook signature verification (LemonSqueezy, Stripe, etc.)
- Input validation on all endpoints (Zod schemas)
- Subscription/access control middleware

---

## New Project Checklist

### User Setup (before Claude Code)
- [ ] Create GitHub repo (public or private as needed)
- [ ] Define project concept
- [ ] Confirm with user: use Linear for this project?

### Claude Code Setup
- [ ] Create `.claude/specs/{project}-spec.md`
- [ ] Review and refine spec with user
- [ ] If using Linear: import implementation phases as Linear epics with sub-issues (`issue-tracker-cli import`)
- [ ] `node ../build-policy/scripts/policy.js scaffold` — gitignore, CI, dependabot, husky, standard scripts, CHANGELOG
- [ ] Install quality devDependencies (eslint + plugins, prettier, husky, license-checker, html-validate/stylelint as applicable)
- [ ] Bootstrap the allowlist: `node ../build-policy/scripts/bootstrap-allowlist.js .`
- [ ] Setup `.env`; create project CLAUDE.md
- [ ] `node ../build-policy/scripts/policy.js check` — must pass before building
- [ ] Build entire app per spec
- [ ] `policy gates` before presenting; developer tests all features
- [ ] Update README with setup instructions

---

## Quick Commands

### PM2 (Node.js)
```bash
npm run restart:pm2
pm2 logs {app-name}
pm2 status
```

### Stale Build Detection

All PM2-managed apps include `server/buildCheck.js` — detects when source files have changed since the last build (e.g. files synced from another computer). Shows a warning banner in the UI so the user knows to rebuild.

**How it works:**
- `npm run build` writes a `.last-build` timestamp file as its final step
- On server start, `buildCheck.js` compares newest source file mtime against `.last-build`
- If source files are newer → exposes `buildStale = true` via `/api/build-status`

**Important rules for `buildCheck.js`:**
- `newestMtime()` must skip non-source directories: `node_modules`, `dist`, `local_data`, `.git`
- Must also skip `.log` files
- `.last-build` write must be the **last step** in the build script (after any `cd server && npm install`)

**Standard implementation:**
```js
const SKIP_DIRS = new Set(['node_modules', 'dist', 'local_data', '.git'])

function newestMtime(dir) {
  let newest = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        newest = Math.max(newest, newestMtime(full))
      } else {
        if (entry.name.endsWith('.log')) continue
        newest = Math.max(newest, fs.statSync(full).mtimeMs)
      }
    }
  } catch { /* directory doesn't exist */ }
  return newest
}
```

**Build script pattern** (`.last-build` always last):
```json
"build": "tsc --noEmit && vite build && cd server && npm install && cd .. && node -e \"fs.writeFileSync('.last-build',Date.now().toString())\""
```

### Build & Check
```bash
# JS/TS
npm run build && npm run lint && npm run type-check

# Python
python3 -m black . && python3 -m ruff check . --fix && python3 -m ruff check .
```
