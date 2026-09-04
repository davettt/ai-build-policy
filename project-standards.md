# Project Standards

**Version:** 2.32
**Last updated:** 2026-09-05

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

# Initialize Git before building
git init
```

For software projects governed by this policy, initialize Git before building:
`git init`, scaffold the policy files, create the initial project shell, and have the
developer make an initial baseline commit. CodeRabbit needs an existing `HEAD` to
review later work; without one, the first real build is harder to gate cleanly.

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
- **Secret storage — what it defends against, and what it does not.** The property being bought is that a config file copied to another machine does not decrypt, because the key is derived from that machine. It is not protection against code running as the user on the same machine: `hostname` and `username` are readable, so the key is derivable, and the value at risk is the user's own BYOK API key rather than user data or payment details. Stated because the scheme reads like strong encryption and is not; it is machine-binding.

  Reviewed and kept deliberately (2026-08-23) after an automated review proposed a keychain-held root key, a KDF, and AES-GCM:
  - **Keychain root key: rejected.** macOS keychain ACLs bind to the code signature, so a re-signed build loses access. That is the exact failure that forced the migration off `safeStorage`, and it surfaces at app startup as a prompt or a key that no longer decrypts.
  - **AES-GCM: rejected as not worth the migration.** Authenticated encryption matters when an attacker can write but not read. Here anyone who can write the config can also read it and derive the key, so it closes no open gap, while costing a format change and a migration across every shipping app.

  Revisit if the stored value ever becomes something other than a user's own API key.

- **Native modules** (e.g. better-sqlite3): add `"postinstall": "npx @electron/rebuild -f -w <module>"` and `"asarUnpack": ["**/*.node"]` in electron-builder config.
- **The running version is visible without an update being available.** A user filing a bug report needs to answer "which version are you on?". In 5 of 11 Electron apps here the only place the version appeared was the update banner, which shows solely on a mismatch. macOS does expose it through About and Finder's Get Info, but that is a per-app menu a project can replace, and "click the app name in the menu bar" is a poor instruction to give the same way across every app.

  **Required:** the settings surface carries a footer line naming the app and version — `<App Name> v2.0.2`. Settings is the mandate because every app has one, it has room for the full string, and one consistent instruction ("open Settings, scroll to the bottom") then works everywhere, which is the whole point for support.

  **Optional:** an additional always-visible version, bottom-left or near the logo. Good where there is spare chrome; not mandated, because a content-focused app like a reader should not spend permanent screen space on it. The best content model pairs name and version with a privacy line in the settings footer.

  `check` FAILs when the version identifier is only ever interpolated inside the update banner. Passing it to a server (`process.env.APP_VERSION = app.getVersion()`) is not showing it.
- **The settings footer is the same surface in every app.** One place, and one support instruction ("open Settings, look at the bottom") that works whichever app the user is in. That portability is the point; a version sitting somewhere different in each app barely helps someone talking a user through it.

  **Settings means whatever that app uses**: a route, an inline panel, or a modal. The footer goes at the foot of that surface whichever shape it takes. The checks match content anywhere in the source, not a file name or a route, so no shape is favoured and none needs a settings page invented for it.

  **Export diagnostics may live in the app menu instead.** That is often the better home: a menu item still works when the app's own UI is misbehaving, which is exactly when someone needs to send logs. Either location satisfies the check.

  ```
  <App Name> v2.0.2
  © 2026 <Your Name>
  Terms · Open source licences · Export diagnostics
  ```

  **"Licences" alone is the wrong label**, because it names two different things and shows only one. A buyer reads it as the licence they bought; the file behind it is dependency attribution. So the footer carries both, named for what each is: **Terms** links the product terms page (which is also where the BYOK privacy disclosure lives), and **Open source licences** links `THIRD-PARTY-LICENSES.txt`. The check enforces the distinction by accepting only the specific wording: "Open source licences" and "Third-party licences" pass, bare "Licences" does not.

  Each line earns its place. The **version** answers the first question any bug report needs. The **copyright notice** names who made the app and when, which matters for a paid product; it is identification rather than protection, since copyright subsists without it. Drop "All rights reserved" — it is a Buenos Aires Convention relic that stopped doing any work once every relevant country joined Berne. **Open source licences** links `THIRD-PARTY-LICENSES.txt`, which apps ship and none surfaces, leaving it inside the bundle where a user cannot reach it. **Export diagnostics** is the support path (§ Diagnostics Logging).

  Adapt the content to the app: a project with no AI needs no privacy disclosure, and the open source licences link applies once the app ships an attribution file. `check` FAILs on a missing copyright notice, on a shipped `THIRD-PARTY-LICENSES.txt` that nothing links to, and on a missing "Export diagnostics" affordance.
- **External links open in the user's browser.** `setWindowOpenHandler` must call `shell.openExternal` and deny the window, and `will-navigate` must do the same for any URL outside the local server origin. Both are needed: the first catches `target="_blank"` and `window.open`, the second catches a plain in-page link that would otherwise replace the app's UI with a web page and strand the user with no way back. Without them Electron opens a new `BrowserWindow` — Chromium with no address bar, no back button and no session shared with the browser the user actually uses. Denying the window without opening externally is worse than doing nothing, because the link then silently does nothing at all. `check` FAILs an Electron project with no `shell.openExternal` call.
- **The update banner links to the app's changelog page, not to a store.** A URL baked into a shipped DMG cannot be changed for anyone who already installed it. The changelog page is the one end of that link that stays editable, so it is what the app must point at; the changelog page then carries the download link. Pointing an installed app straight at a store means that if distribution ever moves, every copy already out there has a dead link and no route to the update. `check` FAILs an Electron project whose source fetches a `version.json` but contains no `/changelog/` URL, and the marketing-site half is checked separately (below).
- **Site-side, checked when `policy check` runs in the marketing-site repo:** every app directory publishing a `version.json` must have a `changelog/index.html`, that page must link to the store so a customer sent there by the banner can actually download, and the `url` field in `version.json` must be that changelog page. These are obligations rather than tidiness because the far end of the link lives in software already on customers' machines and cannot be fixed there.
- **No in-app license gate** — the store download is the gate (matches all shipping apps). An activation check puts a network dependency in the startup path, burns an activation on every validation, and needs somewhere to store the key.
- **These four are enforced, not advisory.** `check` FAILs an Electron project that carries a puppeteer dependency, calls the store licence API, uses `safeStorage`, or has no `findFreePort()`. Matching is on imports and calls, so discussing `safeStorage` in a comment (to record that a project moved off it) does not flag.
- **Electron itself is audited, despite being a devDependency.** The `security` script is `--omit=dev` because the gate models shipped risk and dev dependencies do not ship. Electron is the exception: electron-builder bundles it into the DMG, so Chromium is in the shipped artifact while sitting in `devDependencies`. `gates` therefore audits the full tree for Electron projects and FAILs on an Electron high or critical advisory only, leaving dev-chain advisories out of the gate. It runs in `gates` rather than `check` because it is a network call and the session-start hook has a 10 second budget. When it fires, check whether the fix is inside the declared range: if so `policy deps-update` resolves it, otherwise it needs a major upgrade decision (`policy upgrade electron`).
- **Scaffolding a new app: never copy an existing project wholesale.** `policy scaffold` writes `electron/main.js` (with `findFreePort()`, `contextIsolation`, no `titleBarStyle`) and `server/secret-storage.js` (AES-256-CBC, machine-derived key, `enc:` prefix, plaintext migration). A freshly scaffolded app passes the Electron checks with no edits, so there is nothing to copy from another project. Where a worked example helps beyond that, the reference is named here for the specific pattern — copying a project chosen for being nearby is how a one-off divergence becomes a convention.
- **Version check:** fetch `yourdomain.com/<app>/version.json` on launch with a cache-busting param (`?t=${Date.now()}`) so CDN caching can't hide a release; show the update banner on a **simple version mismatch** (`site.version !== APP_VERSION`), not a semver "newer than" comparison. The mismatch check is deliberate (decided 2026-07-15): it needs no comparison function, and it makes banner verification self-testing at every release — install the new DMG while the site still lists the old version and the banner MUST appear (same code path a user's old app hits); update the site and it MUST clear. Cosmetic trade-off accepted: during the upload window the developer's own new build shows a banner naming the older site version — nobody else ever sees that state. The live banner is verified twice per release via the release checklist (`verify-ready --release`). Apps still on a semver comparison (e.g. a-reference-app): migrate to the mismatch check when next touched.
- **Data safety:** schema version + migration-on-load + pre-migration backups + downgrade guard are mandatory — see § Data Migration, Backups & Downgrade Guard.
- **Diagnostics:** structured local logging + "Export diagnostics" — see § Diagnostics Logging.
- **Privacy disclosure:** BYOK apps send user content to the configured AI provider — state this consistently in the app's settings UI, README/listing, and the site's terms page. No commercial release without the disclosure in place.
- **Both providers, not one.** A BYOK app must wire up Anthropic *and* OpenAI. Supporting one makes an account with that vendor a condition of using the app, which is a purchase barrier rather than a preference: a buyer who already pays OpenAI should not need a second vendor relationship to open something they bought. `check` FAILs an Electron project that calls one provider and not the other, matching on the SDK import or API host rather than the vendor's name, since settings copy, type unions and stale-key migrations mention providers an app never calls. Apps with no AI at all are not flagged. The reference shape is a `MODELS` map keyed by provider with per-provider stored keys and a per-provider validation path.

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
    "afterAllArtifactBuild": "build/notarize-dmg.cjs",
    "files": ["electron/**/*", "server/**/*", "dist/**/*", "!local_data/**", "!**/*.map"],
    "directories": { "output": "release" },
    "asar": true,
    "asarUnpack": ["**/*.node"]
  }
}
```

**`mac.notarize` covers the app, not the DMG. Both are required.** electron-builder submits and staples the `.app`, then packages that stapled app into a disk image afterwards, and never submits the container itself. Every DMG built this way is unsigned: `codesign` reports "code object is not signed at all" and `spctl` "no usable signature" on the DMG, while the app inside verifies as "Notarized Developer ID". Checked across four shipping apps here and identical in all of them, so it is a builder default rather than a per-project mistake.

It is easy to miss because a stapled app is approved however it arrives. Dragging the app to Applications works, and installs succeed. The gap is at *download* time: Gatekeeper evaluates the quarantined disk image when it is opened, before the app inside is reachable, and an unsigned container is the case that produces "Apple cannot check it for malicious software".

`afterAllArtifactBuild` runs `build/notarize-dmg.cjs` (installed by `policy scaffold`), which signs, notarizes and staples the container in that order. Notarization needs a signed artifact, and a ticket only staples to the exact bytes submitted, so signing after stapling invalidates both. Failures throw, rather than emitting an artifact that looks finished.

Enforced at two points, because config being right is not evidence the credentials resolved. `check` FAILs when `afterAllArtifactBuild` is absent or points at a missing file. `verify-ready --release` assesses the built DMG itself with `spctl -a -t open --context context:primary-signature` plus `stapler validate`. Verify by hand with the same command. The `--context` flag is what makes it the disk-image evaluation rather than a different policy that can report a pass Gatekeeper would not give the customer.

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
- **Model entries review every 60 days, not the registry default of 90.** Model families now turn over faster than a quarter, and a stale entry costs more than an out-of-date name: Sonnet 5 superseded Sonnet 4.6 at a *lower* price ($2/$10 per MTok against $3/$15), so sitting on the old ID meant paying more for less. Each model entry records its price at verification, so a review can answer "is the newer one cheaper" without researching the model it replaced. Compare price as well as capability, and in both directions — a newer model is not automatically dearer.

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
npm run security    # npm audit --audit-level=high --omit=dev (gate = shipped deps; health audits full tree)
                    # Electron projects: `gates` additionally audits Electron itself — see below
npm run sast        # semgrep scan --config auto --error (with exclusions)
```

**Semgrep rule exclusions** (triaged 2026-07-13, all false positives in local-data Express apps):
- `path-join-resolve-traversal` — fires on every `path.join()` with a variable; all route params validated via `validateParam` middleware (`^[a-zA-Z0-9_-]+$`); internal server paths don't involve user input
- `express-path-join-resolve-traversal` — Express variant of the same; same validation applies
- `express-res-sendfile` — can't detect validation guards (`isValidSafetyName` checks `basename === filename` + prefix/suffix) before `sendFile()`
- `remote-property-injection` — can't distinguish static allowlist iteration (`for (const key of allowed)`) from user-controlled bracket keys

These four are the ONLY sanctioned global exclusions. Anything else is suppressed per-line with `// nosemgrep: <rule-suffix>` on the specific finding (e.g. `unsafe-formatstring` on `console.error` of server-internal values), so each suppression stays visible in review. Never exclude `dependabot-missing-cooldown` — it means `.github/dependabot.yml` is missing the template's `cooldown:` block (valid keys are `default-days`/`semver-*-days`; bare `semver-minor:`/`semver-patch:` are invalid and break Dependabot).

**Required ESLint plugins:**
- `@typescript-eslint` — TypeScript-aware rules
- `eslint-plugin-react-hooks` — React Hooks rules
- `eslint-plugin-import` — Import ordering
- `eslint-plugin-security` — Security anti-pattern detection (eval, non-literal require, regex DoS). Sanctioned rule-offs (triaged, too noisy for local-data apps): `security/detect-object-injection`, `security/detect-non-literal-fs-filename`. All other security rules stay on, and the ESLint config must cover ALL first-party code — never add `server/` (or any source dir) to `ignores`.

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
  "security": "npm audit --audit-level=high --omit=dev",
  "sast": "semgrep scan --config auto --error --quiet --exclude-rule javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal --exclude-rule javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal --exclude-rule javascript.express.security.audit.express-res-sendfile.express-res-sendfile --exclude-rule javascript.express.security.audit.remote-property-injection.remote-property-injection",
  "secrets": "betterleaks git . -v",
  "licenses": "license-checker --production --failOn 'GPL-2.0;GPL-3.0;AGPL-1.0;AGPL-3.0' --summary",
  "licenses:file": "license-checker --production --relativeLicensePath | sed -e \"s|$PWD/||g\" -e \"s|$PWD|.|g\" > THIRD-PARTY-LICENSES.txt",
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

### Testing tiers

| Tier | Script | What it covers | Required |
|---|---|---|---|
| Unit | `test:unit` | Logic that needs no server — converters, parsers, formatters, pure functions | Optional; add it when such logic exists rather than bending smoke to fit |
| Smoke | `test:smoke` → `tests/smoke.js` | Every API route returns non-5xx | **Yes**, any project with a server |
| Integration | `test:integration` → `tests/harness.js integration` | Full lifecycles against an isolated server (own port, temp data dir, torn down after) | **Yes**, any project with a server |

`test` runs whichever tiers exist, in order.

`check` FAILs on a stub tier. A `test:smoke` of `echo`, `exit 0`, or `npm run build` passes the gate without testing anything. `tests/smoke.js` and `tests/harness.js` must both exist: an inline `node -e "fetch(...)"` passes only when a server is already running on the dev port, and runs against production data.

**Smoke spawns its own server too, not just integration.** `test:smoke` MUST be `node tests/harness.js smoke`, with `tests/smoke.js` exporting `run(baseUrl)`. A `tests/smoke.js` that fetches a hardcoded dev port only passes when the local app happens to be running, and it probes real user data while doing it. That works on the developer's machine and fails on every CI runner, where nothing is listening. Keep direct invocation available for probing a running instance, but the gate must not depend on it.

**Dynamic port (mandatory), same rule as the Electron main process.** `tests/harness.js` MUST ask the OS for a free port via `findFreePort()`: bind to port 0, read the assigned port, close it, then pass it to the spawned server. A hardcoded test port is not "its own port". Any stale server left behind by other local work can already hold it, the test server's own `listen` loses, and every test then runs against the squatter. Seen in practice: a static file server abandoned on the hardcoded test port answered every API call with its `index.html`, and 9 of 10 integration tests failed as if the app's routing were broken.

Pair it with an identity check in `waitForServer`. A 200 does not prove the server is yours, since any static server returns 200. Assert on a field only your API returns, then fail loudly when another server holds the port rather than timing out or, worse, proceeding.

E2E (Playwright): per-app for commercial apps with complex UI flows. Not a default.

### Prettier baseline

`check` FAILs unless these four keys match. Everything else — `trailingComma`, `arrowParens`, `plugins`, `endOfLine` — is per-project:

```json
{ "semi": true, "singleQuote": true, "tabWidth": 2, "printWidth": 100 }
```

These keys govern line shape: a project that deviates cannot be formatted with another project's config without reflowing every file. `templates/prettierrc` (installed by `scaffold`) satisfies the baseline. Correcting a drifted project requires one `npx prettier --write .` reformat — commit it separately.

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
- **The enforced path is the CLI, not the plugin:** `policy gates` runs `npm run review` (`coderabbit review --agent --include-untracked`) as a blocking gate, and the pre-commit verify-marker refuses commits without it. Do not substitute a plugin or skill invocation for that gate: a skill runs only when invoked, the gate blocks.
- **`--include-untracked` is mandatory** (`check` FAILs without it). The CLI default reviews tracked changes only, and gates run before staging, so new files would pass the gate unreviewed.
- **The gate is conditional on source, and unconditional at release.** The CLI allowance is a few reviews per rolling window, so `policy gates` skips the review when the diff contains only config, docs, or changelog files — there is nothing in it for a code reviewer to read, and spending the review there leaves nothing for the next real change. Any source file in the diff brings it back, `gates --with-review` forces it, and `verify-ready --release` FAILs unless the marker records a CodeRabbit pass, so nothing ships unreviewed. A clean tree is not treated as source-free: the gate still runs, which is what keeps the review_skipped FAIL below catching already-committed work.
- **A skipped review is a failed gate.** On a clean tree with the branch equal to its base, CodeRabbit reports `"status":"review_skipped"` and exits 0. `policy gates` reads the `--agent` output rather than the exit code and FAILs, since no code was examined. To review committed work, diff against the preceding commit (`--base-commit <sha>`). For a root commit, review it as a PR on the remote, or in a scratch repo: copy the files out, `git init`, empty root commit, leave the files untracked, `--include-untracked`.
- **New repos need two one-time steps before the review gate can run**, both surfaced by `policy gates` with the exact command:
  1. **A commit must exist.** CodeRabbit resolves the current branch (`git rev-parse --abbrev-ref HEAD`), so it cannot run in a repo with no commits. `verify-marker` waives itself when there is no HEAD, allowing the root commit; every commit after it is gated normally. Do not use `--no-verify`.
  2. **A base branch, when there is no remote yet:** `git config coderabbit.baseBranch <branch>`. Reviews on a repo with no remote draw the free CLI allowance rather than the org's.

  Run full gates immediately after the root commit; the review then covers the whole scaffold.
- Plugin skills are for the two things the CLI cannot do (it reviews the local working diff only):
  - `coderabbit:autofix` — apply CodeRabbit feedback from **GitHub PR review threads**, per-change approval (use for Dependabot/PR follow-ups)
  - `coderabbit:code-review` — ad-hoc mid-development review between gate runs
- **`verify-ready` gates the build, and an unfinished release blocks the next one.** A clean `verify-ready` run records a pass bound to the gates marker's content hash, and the DMG build guard denies the build without a matching record, so the artifact cannot come from a tree those checks never saw. The sign-off cannot be enforced at the moment it is skipped, because uploading and updating the site happen in a browser; instead `check` FAILs when a DMG exists for the current version with no matching git tag, so an unfinished release surfaces at the next session start. Tag the release commit and push the tag (`git tag v<version> && git push origin v<version>`) as part of finishing a release, not as an afterthought.
- **Security review is enforced, not remembered.** `/security-review` in Claude Code covers auth, data, payment, CORS and secret changes and spends no CodeRabbit allowance, so it is the right second layer now that the review gate is conditional. `verify-ready` FAILs when a security-sensitive file changed without a recorded review. A file counts as sensitive by path name (`auth`, `session`, `login`, `token`, `password`, `credential`, `secret`, `crypto`, `encrypt`, `payment`, `billing`, `stripe`, `cors`, `permission`, `middleware`) or by what it calls (`createCipheriv`/`createDecipheriv`, `safeStorage`, JWT, bcrypt/argon2/scrypt, `cors(` or `Access-Control-Allow`, `fs.rm`/`unlink`/`rimraf`, SQL `DELETE FROM`/`DROP TABLE`). Record the review with `policy security-ack`, which hashes exactly those files: change one afterwards and the record stops applying, because a review of the previous version says nothing about the new one. The Stop hook checks the same condition at turn end, so the requirement does not depend on `verify-ready` being run. The review is still judgment — the machinery only checks that it happened, on this content.
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
- An "Export diagnostics" menu item that zips the logs for the user to email support. This is the privacy-respecting alternative to crash telemetry (which stays a deliberate per-app product decision). Label it to fit the surface: "Diagnostics" in a narrow modal, "Export diagnostics…" in a menu. `check` matches the capability (the word near something that actually writes a file), not the wording.

**A leak test is mandatory wherever diagnostics can be exported.** `check` FAILs an app that has the feature without one. The bundle is a file the user emails out, and these apps hold customer records, personal journals and BYOK keys. The failure mode is silent: the user sends it, and neither party knows what was inside.

Two designs, and the difference matters. A payload built from an **allowlist** of named fields (version, platform, schema version, error counts) cannot leak, because nothing unlisted can appear. A payload that **dumps log files** is more useful for debugging but is only as safe as every `log.*` call site, forever. One careless `log.info('saved', { entry })` and the promise printed at the top of the bundle becomes false. Dumping logs is allowed; carrying that risk untested is not.

The test writes known canaries through the app's real paths (a piece of user content, and an API-key-shaped string), then asserts neither appears in the diagnostics output:

```js
assert.ok(!body.includes('Photosynthesis'), 'diagnostics leaked the source material');
assert.ok(!body.includes('smoke-test-key'), 'diagnostics leaked the API key');
```

Log call sites are where leaks actually enter. One app drops provider error text on its AI routes, because a provider that echoes the offending request would put the user's wording into the bundle, and truncating "only bounds the leak rather than removing it". That judgment is right and cannot be enforced by reading code, which is why the canary test exists.

### Third-Party License Attribution (shipped apps)

`npm run licenses` validates license compatibility; attribution is the other half of the obligation:
- `npm run licenses:file` generates `THIRD-PARTY-LICENSES.txt`; regenerate when dependencies change and include it in the app bundle. The script strips the build root: license-checker prints absolute paths in `path:` and `licenseFile:`, and this file ships to customers and is committed to public repos, so it must not carry the build machine's home directory. `verify-ready --release` FAILs on any `/Users/<name>/...` left in it (add to electron-builder `files`).

**Private content in tracked files.** `check` FAILs on an absolute home path (`/Users/<name>/...`, `/home/<name>/...`) in any tracked file. The `.gitignore` and tracked-file checks above cover private *files*; this covers identifying content inside files that are legitimately committed, which is how generated artifacts such as `THIRD-PARTY-LICENSES.txt` published a username and directory layout. Placeholder usernames (`/Users/you/`, `/home/yourname/`) are permitted, so documentation and UI hints are unaffected.

**Security checks block, they do not report.** `check` runs at session start, which is a report a session can proceed past. The commit-time control is `policy leak-scan` in `.husky/pre-commit`: private files tracked in git, and absolute home paths in tracked files. Two git commands, ~30ms, no network. The public policy mirror additionally carries a `pre-push` guard running `policy mirror`, installed by `setup-machine`, because anything pushed there is world-readable and redaction after the fact is not a fix.

- `verify-ready --release` fails for Electron apps without it.

### Supply Chain Security (Socket)

Socket CLI (`@socketsecurity/cli`) is installed globally with the npm wrapper enabled. Every `npm install` is automatically scanned for malicious packages, typosquatting, and supply chain risks.

**Socket is also an enforced gate — locally, not in CI.**

- `socket:scan` (`socket ci`) is a required npm script. In local full gates it runs **only when `package-lock.json` or `package.json` changed** — the dependency tree cannot have moved otherwise, and the free tier is 1,000 scans/month across all projects.
- Dependabot branches are scanned locally before merge (the `dependabot-reviewer` agent runs `socket:scan` per branch).
- **CI does not run Socket.** Those two controls already cover every path a package takes into the lockfile: the wrapper at install time, and the pre-merge scan for Dependabot. A CI step would re-scan a lockfile cleared before the commit existed, costing an API quota unit per run and requiring `SOCKET_SECURITY_API_KEY` in every repo. Add a CI step only for a project with contributors who do not install through the wrapper, or where Dependabot branches merge without local review.

This is the only gate covering a compromised maintainer or a typosquat. `npm audit` reports published CVEs and the allowlist checks package names; neither detects a package whose latest release has become malicious.

**Required API token scopes.** `socket ci` and `socket scan create --report` fetch the org security policy, so a token without `security-policy:read` produces a partial failure: the scan succeeds and the report request returns 403. Minimum set: `security-policy:read`, `alert-resolution list/create/read`, `alerts list`, `alerts trend`, `threat-campaigns list`.

**Starting a new project: bypass the wrapper, not Socket scanning.** The wrapper scans package by package as they install, so a first install of a normal stack costs several hundred scans against a 1,000/month allowance and fails partway when the allowance runs low. Scanning the finished tree instead costs one scan and covers the same packages. This is the sanctioned path for a first install, and it is an explicit exception to precondition 1 below, which would otherwise forbid the only remedy available:

```bash
socket raw-npm install --ignore-scripts   # tree lands; no package runs any code
socket scan create --report               # one scan, whole resolved tree
npm rebuild                               # only after the scan is clean
```

`--ignore-scripts` is what makes this equivalent rather than weaker. The wrapper's value is stopping a malicious package before its install scripts execute; here nothing executes until the tree has been scanned and passed. `npm rebuild` then runs the lifecycle scripts of packages that declare them, which is what native modules such as better-sqlite3 need. If the scan flags something, remove it before running `npm rebuild`.

Electron 42 and later declare no `postinstall`: `index.js` checks for the binary and fetches it on first use, so `npm rebuild` correctly does nothing for it and an absent `dist/` after install is expected. Electron 41 and earlier do declare one, and `npm rebuild` runs it.

**A 429 may be quota, not rate.** Check with `socket organization quota` before retrying. A rate limit clears by waiting; a depleted quota does not, and each retry consumes what is left rather than waiting it out.

**When the wrapper rate-limits (HTTP 429).** The wrapper's install path can return `429 Too Many Requests` while Socket's read API remains available. A 429 indicates the package has not been scanned. It is not a security verdict and must not be treated as a pass.

`socket raw-npm <cmd>` is the supported bypass. It is permitted only when all four conditions hold:

1. **The change is known and bounded** — a specific advisory, an identified package, a target version. Never a blanket install of arbitrary new dependencies, with one exception: a new project's first install, which is blanket by nature and follows the tree-scan procedure above.
2. **The target version is scored clean first**, via the read API that stays up during a 429: `socket package score npm <pkg>@<version> --markdown`. Check `supplyChain` and `vulnerability`. Anything below ~0.9 on supply chain, or any new `malware` / `installScripts` / `obfuscatedFile` alert, stops the bypass.
3. **A full scan runs immediately afterwards**: `socket scan create --report --no-interactive` — confirming the resulting tree still passes policy.
4. **The lockfile diff is inspected** — `git diff package-lock.json` shows only the expected bump and its transitive closure, nothing unrelated.

**Not permitted as a 429 workaround:** `socket wrapper --disable`, invoking the nvm binary directly (`~/.nvm/.../bin/npm`), or unsetting the alias. Each disables scanning without recording that it was skipped, and the first two persist beyond the current command.

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

Major version bumps are ignored by Dependabot — they often include breaking changes that require manual migration and testing. Handle them via the enforced flow below, not from memory.

**Major upgrade flow (enforced — `check` and `verify-ready` FAIL on an un-recorded major):**

Because majors are manual, different sessions used to reason about the migration from model memory and reach conflicting — sometimes fabricated — conclusions (e.g. inventing a peer-dependency constraint instead of reading it). The fix is to ground the upgrade in registry facts and record the decision:

1. `node ../build-policy/scripts/policy.js upgrade <pkg> [targetVersion]` — pulls the target's **real** `peerDependencies`, the installed version, and the upstream migration source from `npm view`, prints them, and scaffolds `.claude/specs/deps/<pkg>-v<major>.md`.
2. Complete the record's "To complete" sections **citing the tool output and the upstream migration guide only — never recalled knowledge.** Peer constraints below the required major are flagged `⚠`; each such peer is itself a major upgrade needing its own record.
3. Apply the change, run `policy gates`, record the PROCEED/DEFER/REJECT decision in the record.

The enforcement: `auditMajorUpgrades` compares the working `package.json` against the committed one; any dependency whose **major** increased must have a matching decision record or `check`/`verify-ready` fail (pre-commit, same window as the CHANGELOG check). The record lives in `.claude/specs/deps/` — gitignored like all specs, carried between machines and sessions by file sync — and the check reads it from disk, so the next session inherits the grounded finding instead of re-deriving it.

> **Anti-fabrication rule (applies to any session, any agent):** claims about a dependency's breaking changes or peer requirements must cite `npm view` output or the fetched upstream migration guide. A subagent that "researches" a migration from memory will hallucinate constraints — the same failure the verified-dates registry prevents for model IDs.

### Never hand-edit package-lock.json

The lockfile is generated, not authored. Change it only by running npm (`npm install`, `npm update`, `policy deps-update`), and revert an unwanted change with `git checkout package-lock.json`.

Packages that ship native binaries (rolldown, lightningcss, `@tailwindcss/oxide`, esbuild, swc) declare every platform variant as an optional dependency, and npm records a resolution for all of them whatever machine generates the file. Removing the ones the current machine does not need leaves the declarations pointing at entries that no longer exist. That installs cleanly locally and fails on Linux, so the first symptom is a broken CI build with no apparent cause, often days later.

`check` and `gates` FAIL when a lockfile declares platform binaries it has no resolutions for. The rule looks only at families of two or more platform-named siblings, so genuinely optional native modules such as `canvas` are unaffected.

### Keeping dependencies current

Two lanes, both minor/patch only. Majors always go through `policy upgrade <pkg>` and its decision record.

**Local refresh (`policy deps-update`)** is the primary lane. It runs `npm update`, which moves each package to the newest version its declared range allows and does not rewrite the ranges in `package.json` (npm's documented behaviour). With `save-prefix = ^` that means minor and patch. One command brings the whole tree current, verified by one full gates run rather than one review cycle per package.

Guardrails, all automatic: the lockfile changing makes `gates` run the Socket supply-chain scan; `min-release-age=1` quarantines anything published in the last 24 hours; full gates and tests must pass before the commit is possible; the change needs a CHANGELOG entry like any other.

Run it when `check` reports drift, and before starting feature work rather than in the middle of it.

**Dependabot** remains the safety net for anything the local lane misses, and the notification channel for advisories. It raises one PR per package, which is why it cannot be the primary lane: the PRs accumulate faster than the review-scan-merge cycle clears them. Once a local refresh lands on main, superseded PRs close themselves.

`check` warns at session start when more than 10 packages sit behind their allowed range and the last refresh is over 30 days old. It warns rather than fails, since a routine refresh should not block unrelated work. The count is cached and re-measured at most once a day, because `npm outdated` is a network call and the session-start hook has a 10 second budget.

**Dependabot PR Flow (minor and patch only, with Socket):**
1. Review the Dependabot PR on GitHub — confirm it is a minor or patch bump
2. `git fetch origin` to pull the branch locally
3. `git checkout <dependabot-branch-name>`
4. `npm run socket:scan` to scan for supply-chain risks using the same org/policy/quota as `policy gates`
5. `npm install && npm run quality` to verify build, lint, types, SAST, and security all pass
6. If clean, merge on GitHub
7. `git checkout main && git pull` to return to main

**Commands:**
```bash
npm run socket:scan                         # Canonical project supply-chain scan
socket scan create --report --org your-org  # Direct whole-tree scan under the org
socket npm install <pkg>                    # Install with Socket scanning (automatic if wrapper is on)
socket fix                                  # Fix CVEs in dependencies
socket wrapper on/off                       # Enable/disable automatic npm wrapping
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
| Smoke/integration tests | Yes (self-contained server lifecycle) | Yes (`--if-present`, self-contained server lifecycle) |

Smoke and integration tiers must be safe in both places: they start their own server,
use a temporary data directory, and tear down after themselves. A test that depends on
the PM2/dev instance is not a gate test; it is a manual probe.

GitHub Actions versions are tracked in `registry.json` with verified dates, and pinned by commit SHA in `templates/ci.yml`. The two notations state the same fact, so `check` FAILs when a `gh-action-*` entry names a version the template does not pin, matched on the `# vX.Y.Z` comment beside each SHA. Bumping the registry without the template is the direction that matters: it reads as done while CI still runs the old action.

**Action runtimes carry hard external deadlines, unlike a version bump.** GitHub removes Node 20 from hosted runners on 2026-09-23, and any action still declaring `node20` stops working that day — the `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` opt-out, which has kept them running since the 2026-06-16 default flip, is removed with it. That is why these three entries review every 90 days rather than 180: a review window is a way of noticing drift, and it is the wrong instrument for a published cutoff, since the old 180-day window would have expired more than two months after the date. When a bump is forced by a runtime deprecation, read the intervening majors rather than jumping to latest blind — the ones here included a credential-handling change, a fork-PR checkout restriction, and a narrowing of automatic caching, none of which are runtime work.

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

**Register apps by script path, never `pm2 start npm`.** PM2 resolves `npm` to an absolute path when the app is registered, and pins the interpreter alongside it, so an app started that way is bound to whichever Node was active that day. It keeps working until that version is removed, and it does not follow the daemon onto a new runtime — after an `nvm install` + `pm2 update`, every other app moves and that one does not. Start the entry file the `start` script would run:

```bash
pm2 start server/index.js --name {app-name}   # not: pm2 start npm -- start
```

Found 2026-09-01: after a Node version bump, one app was left behind on the previous runtime while every other app moved. Check with `pm2 jlist` and look for a version path in `pm_exec_path` or `exec_interpreter`; re-register with `pm2 delete` then `pm2 start <entry> --name <app>`, and `pm2 save`.

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
