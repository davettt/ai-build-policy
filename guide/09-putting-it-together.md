# 9. Putting it together

The earlier chapters describe each part on its own. This one is the order I'd build them in if I were starting from nothing, so that each step works before the next one depends on it. Each step names the samples that do it, which are there to read and adapt rather than copy as they are.

## 9.1 One project for the shared parts

Make a separate project for the scripts, hooks and templates, the way build-policy sits apart from my apps (chapter 1). Even with one app, a change to the process is then its own change, reviewed and tested on its own, and not mixed in with a feature.

## 9.2 Start with what can't be undone

The first checks to set up are the ones that stop something permanent, which is a secret or private data reaching a commit. Add `.env` and the data folder to `.gitignore` (2.5, 5.1), and put a pre-commit hook in each app that scans the staged files for secrets and runs the quick checks like lint and format. `samples/pre-commit` does this without any of the other parts.

## 9.3 Then one gates command and its marker

Next, write one command that runs your quality checks in order, stops at the first failure and writes a marker with a hash of the files it checked (3.2). Then have the pre-commit hook refuse a commit of source files whose hash doesn't match the marker. `samples/gates.js` and `samples/verify-marker.js` are a small version of both.

## 9.4 Then the assistant hooks

With the gates in place, add the Claude Code hooks that catch problems while the assistant is still working (1.1). A Stop hook won't let it finish a turn with changed source and no changelog entry, and a PreToolUse hook refuses a release build while there are uncommitted changes. `samples/stop-hook-changelog.js` and `samples/pretool-hook-clean-build.js` each come with the settings snippet that turns them on. If you use other assistants as well, give them an `AGENTS.md` listing the commands to run, since only the git hook holds them.

## 9.5 Then dependencies

Add the allowlist check to the gates, build a first allowlist from the packages you already have, and set `min-release-age` in `~/.npmrc` (chapter 4). `samples/bootstrap-allowlist.js` builds the first list, `samples/check-allowlist.js` is the gate, and `samples/verify-package.js` looks a new package up before it goes on the list.

## 9.6 When there's a second app

Once a second app exists, move the files every app shares into templates in the shared project, and add a check that reports when an app's copy has drifted (2.4, 7.2). The registry and the report log (7.1, 7.5) belong at the same point, because both are for keeping several projects in step.

## 9.7 Check that each check can fail

A check that has never failed may not be checking anything (1.3). After adding each one, make it fail on purpose: stage a file with a fake key, change a file after the gates have run and try to commit, end a turn without a changelog entry, and start a release build with an uncommitted change. If any of them gets through, that check needs fixing.
