# 2. Starting a project

## 2.1 Write a spec first

Before any code, I have the assistant draft a spec, and I review it so a wrong assumption is caught before any code is written. It covers what the app is for, the features, the stack, how the code will be laid out, the data model, any AI or third-party services it uses, and how it will be built in phases. I keep specs in `.claude/specs/` in the project, which is gitignored, so they are a private record of why decisions were made rather than something published.

## 2.2 A short context file

Every project gets a `CLAUDE.md` (and an `AGENTS.md` for other assistants) with the same headings: what this is, the commands, the architecture, the data model, the conventions, and what does not exist yet. The last heading lists what hasn't been built, so the assistant doesn't go looking for a feature that isn't there, or invent one.

I keep these files out of git, because GitHub only needs what CI runs. They are backed up separately, outside git. On a team, a shared `CLAUDE.md` in the repo would make sense, but working on my own there is no one to share it with.

My setup checks that the file exists, is longer than a skeleton and no longer has the placeholder text from the template.

## 2.3 Make the first commit before feature work

I make the first commit myself as soon as the project is scaffolded, before any features. The AI review (3.3) and the pre-commit hook compare changes against the last commit, and with no commit there is nothing to compare against.

## 2.4 Standard files from templates

New projects get the same set of files from templates: the CI workflow, Dependabot config, the pre-commit hook, `AGENTS.md` and `.nvmrc`. When a template changes, I want every project to know it has drifted. A compliance check runs automatically when an assistant session starts in a project (a session-start hook, covered in 7.3), compares each of these files with its template and reports any that differ. One command then copies the template over that project's file. With one app this matters less, but it still helps to keep the files you copy into a project somewhere you can update in one place.

## 2.5 Data lives outside git

User data for local apps lives in a `local_data/` folder that is gitignored, and secrets live in `.env`, also gitignored. The pre-commit scan (chapter 5) is the backstop if one of them is ever added by mistake.
