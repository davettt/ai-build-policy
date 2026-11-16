# 4. Dependencies

An assistant might add a package without being asked if it thinks it helps, and each package is code from someone else that runs with the same access as your app. So I treat a new dependency as a decision that gets recorded, not something that happens along the way.

## 4.1 An allowlist of approved packages

Each project has an allowlist file with every dependency it declares, who approved it, when, and why. A check in the pre-commit hook and the gates fails when `package.json` has a package that isn't on the list, so a package an assistant added quietly is stopped at the commit. Entries also have a re-check date, 180 days for most packages and 90 for anything security-sensitive, and the check fails once an entry is past it.

## 4.2 Look at a package before it goes on the list

Before a new package is approved, a script looks it up on the npm registry (weekly downloads, last publish, whether it is deprecated, how many maintainers) and gets a score from Socket, which looks at things like install scripts, network access and known malware. The score is saved with the allowlist entry. If Socket can't be reached, the package waits rather than going in unscored.

I run installs with npm directly, and Socket scores a package when it is approved. I used to send every install through Socket's npm wrapper, but at the time it looked up the whole dependency tree on each install against a quota of 500 lookups an hour, so the first install of a new project failed partway through. One lookup per new package stays well inside the limit.

Check Socket's terms for your kind of project as well. If the score isn't available to you, the same steps still work on the registry details alone.

## 4.3 Wait before taking a new release

Compromised packages are usually found and pulled within a day or two of being published. Setting `min-release-age=2` in `~/.npmrc` makes npm install only versions published more than 2 days ago. It uses an older version that still fits the range, and stops with an error if there isn't one. Dependabot has a matching cooldown setting, so its pull requests wait as well. I also run `npm audit signatures` in the gates, which checks that what was installed was signed by the registry.

## 4.4 Keep things current in small steps

Falling a long way behind can make the next update a big one. My check looks once a day and warns when dependencies have drifted, and I refresh them within their declared ranges before starting feature work. Major versions are a separate decision: before one, I have the assistant read the actual peer dependency constraints and the migration guide from npm, and write down what changes, rather than guessing from the version number.

Dependabot pull requests get reviewed one branch at a time (I use a small agent for this): check it is a minor or patch bump, verify signatures, score anything new and run the gates, then I merge. I don't hand-edit `package-lock.json`, because npm generates it, so it only ever changes by running npm.

The samples include the allowlist check, the package lookup script and a Dependabot config with the cooldown.
