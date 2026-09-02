/**
 * electron-builder `afterAllArtifactBuild` hook — sign, notarize and staple the
 * DMG container.
 *
 * Why this exists: `mac.notarize: true` submits and staples the .app, then
 * packages that stapled app into a DMG afterwards. The container itself is
 * never submitted, so every DMG this house shipped before 2026-09-02 was
 * unsigned — `spctl -a -t open --context context:primary-signature` rejected it
 * with "no usable signature" while the app inside verified as
 * "Notarized Developer ID". The app half was always correct; only the wrapper
 * the customer actually double-clicks was not.
 *
 * That gap bites at download time, not install time. A stapled app is approved
 * however it arrives, so a DMG dragged to Applications works — which is why
 * this went unnoticed across every app. But Gatekeeper evaluates the
 * quarantined disk image when it is opened, before the app inside is reachable,
 * and an unsigned container is the case that produces "Apple cannot check it
 * for malicious software".
 *
 * Order is not negotiable: sign, then notarize, then staple. Notarization
 * requires a signed artifact, and a ticket can only be stapled to the exact
 * bytes that were submitted — signing after stapling invalidates both.
 *
 * Failures throw. A build that cannot notarize must not produce an artifact
 * that looks finished: silently emitting an unsigned DMG is precisely the
 * failure mode this file exists to end.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** Run a command, surfacing its output on failure — notarytool's rejection
 *  reasons are the whole diagnostic and must not be swallowed. */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).trim();
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${out}`);
  }
}

/**
 * The signing identity, resolved to its full certificate name.
 *
 * package.json carries the short form ("Name (TEAMID)") because
 * electron-builder accepts it. codesign matches that as a substring against
 * every identity in the keychain, so the short form would also match an
 * installer or development certificate if one is ever added. Resolve to the
 * unambiguous "Developer ID Application: ..." name, which is the only kind
 * Gatekeeper accepts for distribution.
 */
function resolveIdentity(configured) {
  if (/^Developer ID Application:/.test(configured)) return configured;
  const listed = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  const matches = listed
    .split('\n')
    .map((l) => (l.match(/"(Developer ID Application: [^"]+)"/) || [])[1])
    .filter(Boolean)
    .filter((name) => !configured || name.includes(configured));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `No "Developer ID Application" certificate matching ${JSON.stringify(configured)} in the keychain. ` +
        `Check: security find-identity -v -p codesigning`,
    );
  }
  throw new Error(
    `${matches.length} Developer ID certificates match ${JSON.stringify(configured)}: ${matches.join(', ')}. ` +
      `Set the full certificate name as build.mac.identity in package.json.`,
  );
}

/**
 * notarytool credentials. The keychain profile is the house standard; the
 * legacy Apple ID triple is still accepted so older projects build unchanged,
 * because failing them here would block a release over a migration.
 */
function credentialArgs() {
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (profile) return ['--keychain-profile', profile];
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    return [
      '--apple-id',
      APPLE_ID,
      '--password',
      APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id',
      APPLE_TEAM_ID,
    ];
  }
  throw new Error(
    'No notarization credentials. Set APPLE_KEYCHAIN_PROFILE in .env and export it from the build script ' +
      '(see CLAUDE.md § Electron App Signing). Create the profile once per machine with:\n' +
      '  xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <team> --password <app-specific-password>',
  );
}

exports.default = async function afterAllArtifactBuild(buildResult) {
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) return [];

  const configured =
    (buildResult.configuration &&
      buildResult.configuration.mac &&
      buildResult.configuration.mac.identity) ||
    '';
  const identity = resolveIdentity(configured);
  const creds = credentialArgs();

  for (const dmg of dmgs) {
    const name = path.basename(dmg);

    console.log(`  • signing DMG        ${name}`);
    run('codesign', ['--sign', identity, '--timestamp', '--force', dmg]);

    console.log(`  • notarizing DMG     ${name} (this waits on Apple)`);
    run('xcrun', ['notarytool', 'submit', dmg, ...creds, '--wait']);

    console.log(`  • stapling DMG       ${name}`);
    run('xcrun', ['stapler', 'staple', dmg]);

    // Assert the outcome rather than trust the steps. `--context
    // context:primary-signature` is the disk-image evaluation specifically:
    // without it spctl assesses the DMG under the wrong policy and can report a
    // pass that Gatekeeper would not give the customer.
    const assessed = run('spctl', [
      '-a',
      '-t',
      'open',
      '--context',
      'context:primary-signature',
      '-vv',
      dmg,
    ]);
    if (!/accepted/.test(assessed)) {
      throw new Error(`DMG signed and stapled but Gatekeeper still rejects it:\n${assessed}`);
    }
    console.log(`  • verified           ${name} — Gatekeeper accepts the container`);
  }

  // No new artifacts: the DMGs were modified in place, and electron-builder
  // already knows about them.
  return [];
};
