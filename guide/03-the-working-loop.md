# 3. The working loop

## 3.1 Plan the size of the change

For a small change, like a bug fix or a config tweak, I have the assistant say what it is going to do in one sentence before it starts. For anything bigger (a feature, a change across several files, anything architectural) I want a written plan with the files affected, the approach and the risks, and I approve it before any code is written.

While it builds, I ask for the work in phases that can each be tested, and a cleanup pass at the end for dead code and repetition. In a cleanup, the risk is that a fix from an earlier release, like an extra check for a case that once caused a bug, looks like unnecessary code to an assistant that doesn't know why it was added. It gets removed and the bug comes back. In its instructions, I tell the assistant to check the changelog before removing a fix like that, and to keep it unless a new design replaces it. This one is a written rule that nothing enforces, and on a change across many files I won't read every line to catch it. If I started seeing old bugs come back, that would tell me it needs a check (chapter 8 is about turning a miss into a check).

## 3.2 Run the gates before anything is called ready

The quality gates run in one command, in order, and stop at the first failure. My order is:

- type-check, lint, HTML and CSS validation, and the formatter check
- a secret scan and the dependency allowlist (chapter 4)
- static analysis (I use Semgrep), `npm audit` and a licence check
- the build, then unit tests, smoke tests, integration tests and browser flow tests where the project has them
- an automated code review of the diff, last: an AI reviewer reads it, not me (3.3)

Quick checks run first and the slower tests run later in the list. When the gates pass, the runner writes a small marker file with a hash of the files it checked, as proof that the gates passed on exactly this code. Two things then use that marker: the assistant's Stop hook won't let it finish a turn with changed code and no matching marker, and the pre-commit hook refuses a commit of source files whose hash doesn't match. The marker only proves the checks ran, and signing off on the change is still mine (3.4).

I run the gates in 3 places, and each run has a different job:

- Before work is called ready, the full set runs. This is the main run, and it happens while the assistant can still fix whatever fails.
- At commit, only a fast subset runs (type-check, lint, format, secret scan, allowlist), along with the marker check. It takes seconds and makes sure what gets committed is what passed.
- On every push, the whole set runs again in GitHub Actions, on a fresh copy of the code, and the CI logs are kept as a record.

## 3.3 Review every diff

Every diff with source changes is read by an AI reviewer before it is committed, and the gate fails on any critical or high finding. I use 2 reviewers: Claude, run headless with no tools and asked for structured output, for ordinary changes, and CodeRabbit for anything touching security, server code, dependencies, a large diff or a release. My gate script picks between them from the diff and says which it chose and why, and only I can choose the lighter one by hand.

Changes to authentication, secrets, payment, CORS or anything that deletes data also get a security review with `/security-review`, a command built into Claude Code, and a record of it tied to the content it examined, so the record goes stale if the code changes afterwards.

## 3.4 Then you try it, and you commit

Last of all, I try the change in the app myself. Then I commit, with a conventional commit message on `main`. The assistant never commits, and I look at the work before each commit.

I keep 2 changelogs, for 2 different readers. Every code change gets an entry in the project's `CHANGELOG.md`. That one is for developers, and I write it so it would still be safe to publish, even in a private repo: what changed, leaving out customer names, paths on my machine and the details of any security problem. Those details, and the reasons behind a change, stay in private records, out of git. Once a version has shipped its section is frozen, and new work starts a new version.

On the app's website, the changelog customers see is shorter and written for users. It says what they will notice, leaves out tool names and process detail, and puts internal work into a single "under the hood" line if it is worth mentioning at all.
