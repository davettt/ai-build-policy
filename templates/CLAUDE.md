# {Project Name} — Claude Code Context

<!-- SCAFFOLD: replace every placeholder below, then delete this line. `policy check` fails while it remains. -->

## What this is

One paragraph: what the project does, who uses it, and what makes it different from
the obvious alternative. Enough that someone reading only this file knows whether a
proposed change belongs here.

## Commands

```bash
npm run dev        # (local tools: never use this — npm run build && pm2 restart <app>)
npm run build
npm run validate   # fast checks
npm run test       # whichever tiers exist
```

Anything non-obvious: ports, pm2 process name, required env vars, how to reset state.

## Architecture

How the pieces fit: entry points, where the server lives, where state lives, how the
renderer talks to the backend. Name the files that matter, so a session does not have
to rediscover them.

## Data model

What is stored, where, and in what shape. Schema version and migration behaviour if
the project has user data on disk.

## Key patterns

Decisions a session must not undo by accident: why something is done the unusual way,
constraints introduced by past bug fixes, invariants the tests rely on.

## What does NOT exist

Assumptions a reader would reasonably make that are wrong. Features deliberately not
built, abstractions deliberately avoided. This section prevents more wasted work than
any other.

## Conventions

Project-specific style or naming that differs from the portfolio defaults in
`build-policy/project-standards.md`. If nothing differs, say so.
