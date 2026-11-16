# 5. Secrets and user data

## 5.1 Keep keys out of git

Secrets live in `.env`, which is gitignored, and the pre-commit hook scans the staged changes for anything shaped like a key (I use Betterleaks for this, with `--staged`). A history scan only sees commits that already exist, so I scan the staged changes before the commit is made. The full gates and CI scan the history as well.

Credentials for signing and notarising a Mac app don't go in `.env` at all; they go in the macOS Keychain (chapter 6).

## 5.2 Storing a user's API key in the app

My apps let people bring their own AI key, which the app has to store. It is stored encrypted, never in plain text, and it stays out of logs and diagnostics.

## 5.3 Don't lose anyone's data

For apps that keep data in local files, I follow a few rules:

- Write to a temporary file and rename it over the old one, so a crash mid-write leaves the old file whole.
- Only save the fields you expect, to stop a request adding fields that should not be there.
- When an operation touches several files, read them all, then write them all.
- Every data file carries a schema version. On load the app migrates older data forward and makes a backup before migrating. If the data comes from a newer version than the app (someone went back to an older build), the app doesn't write anything: it explains why and closes, so the data is still there, unchanged, for the newer version.

## 5.4 Test that a backup restores

Each app with backups has a restore test: it makes a temporary folder, writes data, backs it up, restores it and compares the result with the original. I also check that the test can fail, by confirming it is comparing real data rather than passing on an empty folder.

## 5.5 Confirm before destroying

Anything that deletes or overwrites data in the app asks first, and says what will be removed. The same goes for the assistant: I have it confirm before deleting files, wiping data or force-pushing, even when the request seems to imply it.
