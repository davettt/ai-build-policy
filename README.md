# Building apps with an AI assistant: a guidebook

This is a guide to how I build and ship apps with AI coding assistants (mostly Claude Code, and Codex at times), written for anyone doing the same, whether that is one app or several. It covers the workflow I follow and the reasoning behind each part, and it comes with sample scripts you can read and adapt.

I'm a product manager, and in my day job at a startup a team of developers and QA do the heavy lifting. For the apps in this guide, the team is me and AI agents. I've written it from that solo setup, but I think the ideas carry over to other kinds of teams and can be built into other workflows.

It used to be a copy of my own tooling that you could clone and run. I changed it to a guide because keeping it runnable for someone else was affecting how I wrote my own tooling. The samples here are examples of how I do something, written to stand on their own, rather than a system to install.

## How to read it

The chapters build on each other, but each one should make sense on its own if you only need one part. Sections are numbered by chapter, so 4.3 is the third section of chapter 4.

**1. [Checks, not instructions](guide/01-checks-not-instructions.md)**: why the process lives in scripts and hooks rather than in an instructions file the assistant may not follow, and which kind of hook a check belongs in.

- [1.1 Two places a check can live](guide/01-checks-not-instructions.md#11-two-places-a-check-can-live)
- [1.2 Keep the instructions file short](guide/01-checks-not-instructions.md#12-keep-the-instructions-file-short)
- [1.3 Make a check fail on empty input](guide/01-checks-not-instructions.md#13-make-a-check-fail-on-empty-input)

**2. [Starting a project](guide/02-starting-a-project.md)**: a spec before code, a short context file, and a first commit before any feature work.

- [2.1 Write a spec first](guide/02-starting-a-project.md#21-write-a-spec-first)
- [2.2 A short context file](guide/02-starting-a-project.md#22-a-short-context-file)
- [2.3 Make the first commit before feature work](guide/02-starting-a-project.md#23-make-the-first-commit-before-feature-work)
- [2.4 Standard files from templates](guide/02-starting-a-project.md#24-standard-files-from-templates)
- [2.5 Data lives outside git](guide/02-starting-a-project.md#25-data-lives-outside-git)

**3. [The working loop](guide/03-the-working-loop.md)**: plan, build, run the gates, review, and then you commit.

- [3.1 Plan the size of the change](guide/03-the-working-loop.md#31-plan-the-size-of-the-change)
- [3.2 Run the gates before anything is called ready](guide/03-the-working-loop.md#32-run-the-gates-before-anything-is-called-ready)
- [3.3 Review every diff](guide/03-the-working-loop.md#33-review-every-diff)
- [3.4 Then you try it, and you commit](guide/03-the-working-loop.md#34-then-you-try-it-and-you-commit)

**4. [Dependencies](guide/04-dependencies.md)**: deciding what gets installed, and keeping it current without taking on a compromised release.

- [4.1 An allowlist of approved packages](guide/04-dependencies.md#41-an-allowlist-of-approved-packages)
- [4.2 Look at a package before it goes on the list](guide/04-dependencies.md#42-look-at-a-package-before-it-goes-on-the-list)
- [4.3 Wait before taking a new release](guide/04-dependencies.md#43-wait-before-taking-a-new-release)
- [4.4 Keep things current in small steps](guide/04-dependencies.md#44-keep-things-current-in-small-steps)

**5. [Secrets and user data](guide/05-secrets-and-user-data.md)**: keeping keys out of git, storing them in the app, and not losing anyone's data in an update or a restore.

- [5.1 Keep keys out of git](guide/05-secrets-and-user-data.md#51-keep-keys-out-of-git)
- [5.2 Storing a user's API key in the app](guide/05-secrets-and-user-data.md#52-storing-a-users-api-key-in-the-app)
- [5.3 Don't lose anyone's data](guide/05-secrets-and-user-data.md#53-dont-lose-anyones-data)
- [5.4 Test that a backup restores](guide/05-secrets-and-user-data.md#54-test-that-a-backup-restores)
- [5.5 Confirm before destroying](guide/05-secrets-and-user-data.md#55-confirm-before-destroying)

**6. [Shipping a desktop app](guide/06-shipping-a-desktop-app.md)**: signing, notarising, hardening, telling people an update is out, and building on Windows in CI.

- [6.1 Build only from a commit](guide/06-shipping-a-desktop-app.md#61-build-only-from-a-commit)
- [6.2 Signing and notarising](guide/06-shipping-a-desktop-app.md#62-signing-and-notarising)
- [6.3 Harden the windows](guide/06-shipping-a-desktop-app.md#63-harden-the-windows)
- [6.4 Tell people an update is out](guide/06-shipping-a-desktop-app.md#64-tell-people-an-update-is-out)
- [6.5 Things every app carries](guide/06-shipping-a-desktop-app.md#65-things-every-app-carries)
- [6.6 Build on Windows in CI](guide/06-shipping-a-desktop-app.md#66-build-on-windows-in-ci)

**7. [More than one app](guide/07-more-than-one-app.md)**: what changes when you are looking after several projects at once.

- [7.1 One registry of versions and choices](guide/07-more-than-one-app.md#71-one-registry-of-versions-and-choices)
- [7.2 Templates that report drift](guide/07-more-than-one-app.md#72-templates-that-report-drift)
- [7.3 A check at the start of every session](guide/07-more-than-one-app.md#73-a-check-at-the-start-of-every-session)
- [7.4 Look at projects you haven't opened](guide/07-more-than-one-app.md#74-look-at-projects-you-havent-opened)
- [7.5 Note gaps where you find them](guide/07-more-than-one-app.md#75-note-gaps-where-you-find-them)
- [7.6 Delegate the mechanical work](guide/07-more-than-one-app.md#76-delegate-the-mechanical-work)

**8. [When something gets through](guide/08-when-something-gets-through.md)**: a set path for urgent fixes, turning each miss into a check, and the limits I know about.

- [8.1 A fixed path for urgent fixes](guide/08-when-something-gets-through.md#81-a-fixed-path-for-urgent-fixes)
- [8.2 Public notes about a fix](guide/08-when-something-gets-through.md#82-public-notes-about-a-fix)
- [8.3 Limits I know about](guide/08-when-something-gets-through.md#83-limits-i-know-about)

**9. [Putting it together](guide/09-putting-it-together.md)**: the order to build these parts in if you are starting from nothing, and how to check each one works.

- [9.1 One project for the shared parts](guide/09-putting-it-together.md#91-one-project-for-the-shared-parts)
- [9.2 Start with what can't be undone](guide/09-putting-it-together.md#92-start-with-what-cant-be-undone)
- [9.3 Then one gates command and its marker](guide/09-putting-it-together.md#93-then-one-gates-command-and-its-marker)
- [9.4 Then the assistant hooks](guide/09-putting-it-together.md#94-then-the-assistant-hooks)
- [9.5 Then dependencies](guide/09-putting-it-together.md#95-then-dependencies)
- [9.6 When there's a second app](guide/09-putting-it-together.md#96-when-theres-a-second-app)
- [9.7 Check that each check can fail](guide/09-putting-it-together.md#97-check-that-each-check-can-fail)

The [samples](samples/README.md) folder has the scripts and config files the chapters refer to.

## Before you start

Nothing here needs to be installed for the guide to make sense, and the samples are written for Node.js projects on macOS and GitHub, because that is what I use. You may need to adjust paths, tools and commands for your own setup.

I hope this helps if you give some of it a go.
