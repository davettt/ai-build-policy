# 7. More than one app

With one app you can keep most of this in your head. With several, the same fix has to reach every project, and a project you haven't opened for a month falls behind without you noticing. These are the parts I added to build-policy when I had more than a handful of projects.

## 7.1 One registry of versions and choices

I keep a single file listing the things every project should agree on: the Node version, the AI model IDs the apps use, the versions of Electron and the build tool, and the tools in the gates, each with the date it was last checked. A check warns when an entry is older than its review period, and then I look up the current state, update the registry and update the apps to match.

## 7.2 Templates that report drift

The standard files (CI workflow, Dependabot config, pre-commit hook, `AGENTS.md`, `.nvmrc`) come from templates, and each project's check compares its copy with the template. When I improve a template, every project reports the difference the next time it is opened, and a single command brings that project up to date. A fix made in one project then becomes a change to the template, so every project gets it.

## 7.3 A check at the start of every session

A hook runs the compliance check when a session starts and gives the result to the assistant. Failures are fixed before feature work.

## 7.4 Look at projects you haven't opened

Some projects aren't opened for weeks, so a scheduled job runs the health check across every project once a month and records the result, and the daily advisory scan reads every lockfile against the OSV database (osv.dev, an open database of known vulnerabilities in open-source packages, npm included). When news of a compromised package comes out, one command finds which projects have the affected version and whether it shipped in the last release.

## 7.5 Note gaps where you find them

When I'm working in one app and notice something build-policy should handle, the assistant runs one command that adds a short numbered report to a `REPORTS.md` file in build-policy, instead of changing build-policy from that session (a hook stops app sessions from editing it). The file is committed with build-policy, and closed reports stay in it as a record. The next session I open in build-policy lists the open reports at the start, and they get fixed there. That way a change to build-policy is reviewed and tested as its own change.

## 7.6 Delegate the mechanical work

With several projects, a lot of the work is mechanical: changelog entries, README updates, reviewing a Dependabot branch, searching for a file. I have small Claude Code agents pinned to Haiku, the cheapest Claude model, for those, and keep the main session, which runs on Opus, for planning, cross-file changes and security work. I name the model family in each agent's settings rather than a version, so they use whichever Haiku Claude Code currently points to, and I don't edit them for each new version. It also keeps long tool output (a big search or a full diff) out of the main conversation, where it would be resent on every turn.
