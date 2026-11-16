# 6. Shipping a desktop app

This chapter is about Electron apps on macOS, since that is what I ship.

## 6.1 Build only from a commit

A release build is only made from committed code on `main`. A Claude Code hook refuses the build command while there are uncommitted changes, so a release always matches a commit I can go back to. After the build is verified I tag the commit (`git tag v<version>`), which is the record of what shipped once the build folder has been cleaned out.

## 6.2 Signing and notarising

Apps are signed with a Developer ID and notarised by Apple, with the hardened runtime on and a small entitlements file. The notarisation credentials are stored once per machine with `xcrun notarytool store-credentials <profile>`, and the project's `.env` only names the profile, which keeps the password out of the project. Notarising the app inside the disk image isn't enough on its own, so the DMG itself is signed, notarised and stapled too. I check it after the build with `codesign --verify --deep --strict`, `spctl` and `stapler validate`.

If notarising fails once after it has worked before, it might be Apple's service, so I retry before touching any credentials, and check Apple's system status page if it fails again.

## 6.3 Harden the windows

Every window is created with `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`, written out explicitly rather than relying on defaults. The app sets a content security policy, and Electron fuses limit how the app can be started and what code it loads. External links open in the user's browser rather than inside the app.

`samples/electron-main.js` has a main process set up this way.

## 6.4 Tell people an update is out

The app checks a small `version.json` on my site when it starts, when the window gets focus and once an hour, and shows a banner when a newer version exists, linking to the changelog page. There is also a Check for updates button in Settings. Before publishing the new version I install it over the previous one, confirm the banner still shows (because the site lists the old version), then update the site and confirm the banner clears. I do it in that order, because once the new `version.json` is live the banner no longer shows.

## 6.5 Things every app carries

Each app has a settings footer with the version, a copyright notice, a link to the third-party licences file and an Export diagnostics button. I don't ship crash telemetry; the app logs locally, and the user can choose to export the log and send it.

## 6.6 Build on Windows in CI

I only ship for Mac today, but I want to keep the option of a Windows version open. A CI job (`samples/windows.yml`) builds the app on Windows, runs the unit tests and makes a package, so a Mac-only call (a file path, a system command) shows up when it is added, not months later when I try to port the app. I leave that package unsigned and ship it nowhere, because I haven't chosen how to sign for Windows yet, and it doesn't need signing to show that the code builds.
