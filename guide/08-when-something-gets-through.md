# 8. When something gets through

Things still get past the checks. When a bug reaches a user, a regression shows up, or I catch myself asking the assistant for the same thing twice, I ask which check should have caught it, and then add that check, a test for it or a hook.

## 8.1 A fixed path for urgent fixes

When someone is stuck because of a bug, I follow a short path that is written down in advance:

1. Fix it on `main`, like any other change, and run the gates.
2. Add a changelog entry and a patch version, then review and commit it myself.
3. Install it over the old version and check that the update banner shows and then clears (6.4).
4. Tag the commit, ship the build and update the site.
5. Ask which check should have caught it, and add that check before calling the fix finished.

Planning documents, marketing and non-urgent review threads can wait, and the gates, the changelog, my own commit and step 5 are still done.

## 8.2 Public notes about a fix

When a fix is for a security problem, the public changelog says what is now protected and recommends updating, without describing what was exposed or how. The detail stays in the project's own records.

## 8.3 Limits I know about

- Performance has no gate. Where it matters, I add a timing assertion to a smoke test in that project.
- The checks can make sure tests run, but not that the tests are good. Whether a test is worth having is still a judgment.
- Browser flow tests are per app, and I add them where an app has complex screens.
- The apps don't send crash reports; that is a choice about privacy, and local diagnostics with a user-initiated export take its place.
