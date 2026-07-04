# Project Standards

Quick reference for consistent project setup and development.

---

## How to Start a New Project

### Step 1: Setup
```bash
mkdir my-new-app
cd my-new-app
mkdir -p .claude/specs
git init
```

### Step 2: Start your AI coding tool
```bash
claude  # or codex, etc.
```

### Step 3: First prompt
```
Read project-standards.md

I want to build [describe your app concept here].

Create a spec in .claude/specs/ following the standards, then we'll review before building.
```

### Step 4: Review Spec -> Build -> Iterate
1. AI creates spec in `.claude/specs/{project}-spec.md`
2. Review and refine spec together
3. AI builds entire app per spec
4. Test and iterate

---

## Pre-Setup Checklist

Before starting:
- [ ] Create project folder with `.claude/specs/` subfolder
- [ ] Create GitHub repo (public or private as needed)
- [ ] Confirm: use an issue tracker for this project?
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
- Frontend: React + TypeScript + Vite + Tailwind
- Backend: Node.js + Express (ES modules)
- AI: Provider API (optional)
- Data: Local JSON files in `local_data/`

### Project Structure
project/
  src/ or {module}/
  local_data/        # Gitignored, user data
  .claude/
    specs/           # Specifications
  .env               # Secrets (gitignored)
  CHANGELOG.md
  package.json

### Data Models
JSON schemas or SQL schemas for all stored data.

### API/AI Integration
- Endpoints needed
- Prompt templates with expected responses
- Cost considerations

## Build Guidelines
- Linter, formatter, type-checker, security checker config
- Code review requirements
- Git workflow for this project

## Implementation Phases
Break into logical phases. Each phase should be testable.
DO NOT include time estimates - just logical groupings.

## Success Criteria
Checklist of what "done" looks like.
```

### Spec Principles
- Be specific: Show exact CLI commands, UI flows, JSON structures
- Include error states and edge cases
- Define data models upfront
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
- Cloud hosting (e.g. Cloudflare Pages, Vercel)
- Serverless API (e.g. Cloudflare Workers, AWS Lambda)
- Database (e.g. D1, PlanetScale, Supabase)
- Object storage for files (e.g. R2, S3)
- Zustand for state management
- ESLint + Prettier

### Electron Desktop Apps (macOS)
- Vite + React + TypeScript + Tailwind CSS (renderer)
- Express backend bundled in the app (ES modules, serves dist/ + /api)
- Electron main process: find free port -> start Express -> load window from localhost
- Zustand for state management
- `contextIsolation: true`, `nodeIntegration: false`
- **PDF export:** use **pdfmake** (pure JS, no Chromium dependency). Do NOT use Puppeteer -- it bundles a ~150MB Chromium binary unnecessarily since Electron already IS Chromium.
- **Secret storage:** AES-256-CBC with a machine-derived key. Do NOT use Electron `safeStorage` -- its encrypted values go stale across app re-signs/updates.
- **No in-app license gate** if using Gumroad/similar -- the download is the gate.
- **Version check:** fetch a `version.json` from your site on launch; show update banner if newer version available.

**DMG Build, Code Signing & Notarization:**

Prerequisites (one-time):
- Apple Developer account with a "Developer ID Application" certificate installed in Keychain
- App-specific password generated at appleid.apple.com

`.env` file (gitignored):
```
APPLE_ID=your@apple.id
APPLE_TEAM_ID=YOUR_TEAM_ID
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

`package.json` electron-builder config:
```json
{
  "build": {
    "appId": "com.yourcompany.appname",
    "productName": "App Name",
    "icon": "build/icon.png",
    "mac": {
      "category": "public.app-category.productivity",
      "target": [{ "target": "dmg", "arch": ["universal"] }],
      "identity": "Your Name (TEAM_ID)",
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

Build script: `"electron:build": "npm run build && export $(grep -v '^#' .env | grep APPLE | xargs) && electron-builder --mac"`

Icon: `build/icon.png` (512x512 PNG). electron-builder converts to `.icns` automatically.

### Python Projects
- Typer + Rich for CLI
- Black + Ruff for formatting/linting
- python-dotenv for env vars

### AI Integration
- Use the cheapest model that works for each task
- Implement caching to reduce API costs
- Rate limiting on expensive endpoints
- Keep model IDs consistent across all apps -- copy from a shipping app, don't invent them
- Periodically verify model IDs are current; don't ship deprecated model IDs

---

## Code Quality

### Principles

These apply to all code changes, in every project, by every AI tool and human.

**Simplicity first.** Prefer the obvious approach. If you need a comment to explain how something works, it's too clever. A straightforward solution that a reader can follow in one pass beats a compact one that requires mental gymnastics.

**DRY with judgment.** Extract when a pattern repeats three or more times. Two similar blocks are not duplication -- they're coincidence. Don't create abstractions for hypothetical future reuse. Three similar lines is better than a premature helper.

**Remove dead code.** Delete unused imports, functions, variables, components, and files. Don't comment code out -- git has the history. Commented-out code rots, confuses readers, and hides real logic.

**Small and focused.** Each function does one thing. Each file owns one concept. A function that needs scrolling is too long -- break it up. A file over ~300 lines should probably be split. A component that handles its own data fetching, state, layout, and business logic should be decomposed.

**No feature creep.** A bug fix is a bug fix -- don't refactor the surrounding code or add features in the same change. Keep changes focused and reviewable.

**Clean as you go.** When touching a file, clean up what you find: unused imports, dead variables, stale comments, inconsistent formatting. Leave the file better than you found it, but don't rewrite it.

**No speculative code.** Don't add feature flags, config options, extension points, or abstractions for requirements that don't exist yet. Build for what's needed now. When the future requirement arrives, refactor then.

### JavaScript/TypeScript
```bash
npm run lint        # ESLint (--max-warnings 0)
npm run format      # Prettier
npm run type-check  # tsc --noEmit (strict: true)
npm run build       # Full build
npm run security    # npm audit --audit-level=high
npm run sast        # semgrep scan --config auto
```

**Required ESLint plugins:**
- `@typescript-eslint` -- TypeScript-aware rules
- `eslint-plugin-react-hooks` -- React Hooks rules
- `eslint-plugin-import` -- Import ordering
- `eslint-plugin-security` -- Security anti-pattern detection (eval, non-literal require, regex DoS)

**Required Prettier plugins:**
- `prettier-plugin-tailwindcss` -- Tailwind class sorting

**Required HTML validation (projects with HTML files):**
- `html-validate` -- structural HTML validation (unclosed tags, mismatched nesting)
- Config: extend `html-validate:recommended`, suppress stylistic rules (`void-style`, `no-implicit-button-type`, `no-inline-style`, `doctype-style`)
- Wire into validate/quality scripts as `lint:html`

**Required CSS validation (projects with CSS files):**
- `stylelint` + `stylelint-config-standard` -- catches duplicate selectors, deprecated properties, invalid values
- Config: extend `stylelint-config-standard`, suppress stylistic rules
- Wire into validate/quality scripts as `lint:css`

**TypeScript strict settings:**
- `strict: true` in `tsconfig.json`
- `noUncheckedIndexedAccess: true`
- No `any` types -- use `unknown` and narrow

**Standard package.json scripts:**
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
  "sast": "semgrep scan --config auto --quiet",
  "check": "npm run lint && npm run lint:html && npm run lint:css && npm run format:check && npm run type-check",
  "quality": "npm run check && npm run sast && npm run security",
  "test:smoke": "node tests/smoke.js",
  "test:integration": "node tests/harness.js integration",
  "test": "npm run test:smoke && npm run test:integration",
  "build": "tsc --noEmit && vite build"
}
```

### Python
```bash
python3 -m black .              # Format
python3 -m ruff check . --fix   # Lint + fix
python3 -m ruff check .         # Verify clean
```

**Run before every commit. No exceptions.**

### Regression Prevention

Before modifying or removing any code that enforces a constraint, cap, guard, or validation:

1. **Check the CHANGELOG** -- search for entries that introduced the code as a bug fix. If it was a fix, it stays unless explicitly superseded by a new design.
2. **Trace root causes precisely** -- don't remove safeguards from unrelated code paths just because they touch the same data.
3. **When reviewing existing changes** -- if asked whether prior edits are still needed, review each change individually against the changelog. Don't blanket-approve.
4. **Regressions are serious** -- every regression costs a rebuild, retest, and re-deploy cycle.

### Code Reviews

- All PRs reviewed by AI code review tool before merge
- Address all critical and high-severity findings
- Supply chain scans on dependency changes (separate from code review)

---

## Git Workflow

- Feature branches: `{username}/{issue-id}-{short-description}`
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
- PR per feature/issue
- AI code review required on all PRs

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
  src/
    components/
    hooks/
    services/
    stores/            # Zustand stores
    types/
    utils/
  server/
    src/
    index.js
  public/
  .claude/
    specs/
  .env
  .gitignore
  CHANGELOG.md
  package.json
  README.md
```

### React Projects (Cloud SaaS)
```
project/
  src/                   # Frontend
    components/
    hooks/
    services/
    stores/
    types/
    utils/
  worker/                # Backend (serverless)
    src/
      routes/
      middleware/
      db/
        schema.sql
    wrangler.toml
  public/
  .claude/
    specs/
  .env
  .gitignore
  CHANGELOG.md
  package.json
  README.md
```

### Python Projects
```
project/
  {module}/
    commands/
    models/
    utils/
    ai/
  local_data/
  .claude/
    specs/
  .env
  .gitignore
  CHANGELOG.md
  requirements.txt
  README.md
```

---

## .gitignore Essentials

```gitignore
# Dependencies
node_modules/
__pycache__/
*.pyc

# Build
dist/
build/

# Environment
.env
.env.*

# Data
local_data/

# Logs
*.log

# OS
.DS_Store

# IDE
.vscode/
.idea/

# Claude Code
.claude/
CLAUDE.md
```

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
- CORS restricted to app domain (not wildcard), regex must be anchored
- Content Security Policy headers on cloud apps
- Return generic error messages to clients -- log details server-side only (no stack traces, DB names, or internals in responses)
- `npm audit` / security check required before every commit
- No high or critical vulnerabilities allowed

### Data Safety (Local JSON Apps)

These patterns apply to all local-first apps that store data as JSON files.

**Atomic writes everywhere:**
- ALL file writes must use `atomicWrite()` (write `.tmp` then `fs.renameSync`) -- never use `fs.writeFileSync()` directly for data files.

**Field whitelisting on API endpoints:**
- Never spread `req.body` directly onto stored objects. Define an `ALLOWED_FIELDS` array per entity and use a `pick(obj, fields)` helper to filter.
- Protected fields (`id`, `createdAt`, `updatedAt`) must always be set explicitly after the spread.

**Multi-file operations:**
- When an operation modifies multiple JSON files, read all data upfront in one batch, compute all changes in memory, then write all files. Never interleave reads and writes.

**Cascade deletes:**
- When deleting a parent entity, always clean up child entities. Orphaned records waste space and appear in backups.

**Test isolation:**
- Integration tests must never run against production data. Start a separate server instance on a dedicated test port with a temporary data directory. Tear down the temp directory after tests complete.

### Supply Chain Security

Use Socket CLI or equivalent to scan every `npm install` for malicious packages, typosquatting, and supply chain risks.

**When to be extra cautious:**
- Starting a new project (`npm install` pulls many packages at once)
- Swapping out dependencies when something doesn't work
- Running `npm audit fix` (can upgrade into a freshly compromised version)
- Merging Dependabot PRs

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

Major version bumps are ignored -- they often include breaking changes that require manual migration and testing.

**Dependabot PR Flow (minor and patch only):**
1. Review the Dependabot PR on GitHub -- confirm it is a minor or patch bump
2. Pull the branch locally
3. Run supply chain security scan
4. `npm install && npm run quality` to verify build, lint, types, SAST, and security all pass
5. If clean, merge on GitHub

**Minimum Release Age:**
Set `min-release-age=1` in `~/.npmrc`. npm will refuse to resolve any package version published less than 24 hours ago. This filters out the riskiest window for supply chain attacks.

### File Uploads (when applicable)
- Per-file size limit (e.g. 5MB)
- Per-account storage cap (e.g. 100MB)
- Validate MIME type server-side (not just file extension)
- Track storage usage per user in database

### API & Auth
- Never rely on frontend route guards for access control -- protect every route server-side
- Apply auth middleware at the router level (not per-route) to prevent gaps
- Validate resource ownership server-side on every request (prevent IDOR)
- Store auth tokens in httpOnly cookies, not localStorage
- Set expiry on all JWTs -- implement refresh token rotation for SaaS apps

---

## New Project Checklist

### Setup (before AI tool)
- [ ] Create GitHub repo (public or private as needed)
- [ ] Define project concept
- [ ] Confirm: use issue tracker for this project?

### AI Tool Setup
- [ ] Create `.claude/specs/{project}-spec.md`
- [ ] Review and refine spec
- [ ] Initialize project structure
- [ ] Configure linting/formatting/type-checking/security checks
- [ ] Setup `.env` and `.gitignore`
- [ ] Create initial `CHANGELOG.md`
- [ ] Build entire app per spec
- [ ] Run AI code review
- [ ] Test all features
- [ ] Update README with setup instructions

---

## Quick Commands

### PM2 (Node.js)
```bash
pm2 restart {app-name}
pm2 logs {app-name}
pm2 status
```

### Stale Build Detection

All PM2-managed apps include `server/buildCheck.js` -- detects when source files have changed since the last build. Shows a warning banner in the UI so the user knows to rebuild.

**How it works:**
- `npm run build` writes a `.last-build` timestamp file as its final step
- On server start, `buildCheck.js` compares newest source file mtime against `.last-build`
- If source files are newer -> exposes `buildStale = true` via `/api/build-status`

**Important rules for `buildCheck.js`:**
- `newestMtime()` must skip non-source directories: `node_modules`, `dist`, `local_data`, `.git`
- Must also skip `.log` files
- `.last-build` write must be the **last step** in the build script

### Build & Check
```bash
# JS/TS
npm run build && npm run lint && npm run type-check

# Python
python3 -m black . && python3 -m ruff check . --fix && python3 -m ruff check .
```
