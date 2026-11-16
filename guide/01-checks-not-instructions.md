# 1. Checks, not instructions

When I started building apps with an AI assistant, I worked with Claude to refine, test and document the process, so it would be followed the same way each time I updated an app or started a new one. It was followed most of the time, but not consistently enough to stop things slipping through: projects drifted, mistakes got through, and steps we had put in place were overlooked. Claude would read the instructions and still not follow them the same way each time, and when I pointed it out, it would say something like "yes, I read that but didn't do it". That happened often enough that I realised building with AI needs checks that run mechanically, the same way every time. So I had the assistant build the process into scripts and hooks, and kept refining them until the process worked each time.

Those scripts, hooks and templates live in one project of their own, which I call build-policy. It isn't an app but the process every app follows: each app runs its checks from it, and a change to the process is made there once rather than in every app. Most of this guide is a description of what is in it.

The rule I work to now is that every step that can be checked by a program is checked by one, or leaves a file behind that a program checks. The steps that need a person, like deciding whether a plan is right or trying the change in the app, are named as judgment steps so it is clear they are not automated.

## 1.1 Two places a check can live

There are 2 places I put checks, and they do different jobs.

**Assistant hooks** run while the assistant is working. Claude Code has hooks that run at the start of a session, before a tool is used and when the assistant tries to finish its turn. A failure here goes straight back to the assistant, which caused the problem and can fix it before you look at anything. This is where I put the workflow checks: the changelog entry, refusing a release build while there are uncommitted changes, and making sure the quality gates (lint, tests and the rest, covered in 3.2) have passed on the current code before the assistant finishes its turn.

**Git hooks** run when you commit. In my setup I make the commits, never the assistant. When a git hook fails, it stops my commit, and I have to take the failure back to the assistant to fix, even though the assistant caused it. I keep git hooks for the things that must never land whatever tool was used: secrets, private data and code that has not passed the gates. Every check in a git hook runs on every commit, which is why I keep them fast.

I only put the same check in both places when getting it wrong is permanent, and the gates are that check. They run once and leave a small marker file recording which version of the code passed. Before the assistant can finish its turn, its hook checks for a marker that matches the current code, and the pre-commit hook refuses the commit without one, in case the first check was somehow skipped.

Other assistants I use don't have hooks like these. For them the git hook is the only automatic check, and it only runs at commit time. It's tempting to move the workflow checks into git hooks so every tool gets them, but then Claude Code would also only hear about a missing changelog entry at commit time, instead of while it's still working. So I leave the workflow checks in the assistant hooks and give the other tools a short `AGENTS.md` listing the commands to run themselves.

## 1.2 Keep the instructions file short

With the process in scripts, the context file only needs project facts: the stack, how the code is laid out, the commands, and anything surprising about the project. The assistant runs the commands and acts on what they report.

## 1.3 Make a check fail on empty input

Something I learned from my own gates is that a check can pass because it looked at nothing. A type-check pointed at a config that includes no files, a test command that finds no tests, a scan of an empty list, can all report success. When I add a gate now, I also make sure it fails when it has nothing to look at, and I test that it fails.

See the samples for a Claude Code Stop hook that blocks the end of a turn when code changed with no changelog entry, and a PreToolUse hook that refuses a release build on a dirty tree.
