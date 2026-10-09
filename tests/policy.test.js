'use strict';

// Regression tests for the predicates the hooks decide on. Run by `policy
// check` in the policy repo (node --test tests/), so a change to policy.js
// that breaks one of these fails check, the Stop hook and the pre-commit hook.
// No dependencies: Node's built-in runner only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const policy = require('../scripts/policy.js');
const ROOT = path.resolve(__dirname, '..'); // this repo, as the hooks see POLICY_ROOT
const PARENT = path.dirname(ROOT);
const ELSEWHERE = path.join(os.tmpdir(), 'policy-tests-elsewhere');

test('bashWriteTargets: redirect target follows cd between segments', () => {
  const w = policy.bashWriteTargets('cd ../other && echo x >> notes.md', ROOT);
  assert.deepEqual(w.targets, [path.join(PARENT, 'other', 'notes.md')]);
  assert.equal(w.unknown, false);
});

test('bashWriteTargets: heredoc body is data for the redirect target, not code', () => {
  const cmd = `cat > notes.md <<'EOF'\nthis mentions build-policy and sed -i\nEOF`;
  const w = policy.bashWriteTargets(cmd, ELSEWHERE);
  assert.deepEqual(w.targets, [path.join(ELSEWHERE, 'notes.md')]);
  assert.equal(w.unknown, false);
});

test('bashWriteTargets: an interpreter segment is unknown and carries its heredoc', () => {
  const cmd = `python3 - <<'EOF'\nopen('x.txt','w').write('hi')\nEOF`;
  const w = policy.bashWriteTargets(cmd, ELSEWHERE);
  assert.equal(w.unknown, true);
  assert.equal(w.unknownSegments.length, 1);
  assert.match(w.unknownSegments[0].text, /open\('x\.txt','w'\)/);
});

test('bashWriteTargets: cp, rm and sed -i name their targets; policy.js commands do not', () => {
  const w = policy.bashWriteTargets(
    `cp a.txt b.txt; rm c.txt; sed -i.bak s/x/y/ d.txt; node ${ROOT}/scripts/policy.js check`,
    ELSEWHERE,
  );
  assert.deepEqual(
    w.targets.map((t) => path.basename(t)),
    ['b.txt', 'c.txt', 'd.txt'],
  );
  assert.equal(w.unknown, false);
});

test('writesUnder: file tools are judged by their path', () => {
  const inside = {
    tool_name: 'Edit',
    cwd: ELSEWHERE,
    tool_input: { file_path: path.join(ROOT, 'README.md') },
  };
  const outside = {
    tool_name: 'Write',
    cwd: ELSEWHERE,
    tool_input: { file_path: path.join(ELSEWHERE, 'README.md') },
  };
  assert.equal(policy.writesUnder(inside, ROOT), true);
  assert.equal(policy.writesUnder(outside, ROOT), false);
});

test('writesUnder: prose naming the repo beside a read is not a write', () => {
  const read = {
    tool_name: 'Bash',
    cwd: ELSEWHERE,
    tool_input: { command: `grep -n "build-policy" ${ROOT}/README.md` },
  };
  const echo = {
    tool_name: 'Bash',
    cwd: ELSEWHERE,
    tool_input: { command: `echo "see ${ROOT}" > /dev/null` },
  };
  assert.equal(policy.writesUnder(read, ROOT), false);
  assert.equal(policy.writesUnder(echo, ROOT), false);
});

test('writesUnder: a redirect into the repo and a script writing a repo path are writes', () => {
  const redirect = {
    tool_name: 'Bash',
    cwd: ELSEWHERE,
    tool_input: { command: `echo x >> ${ROOT}/BACKLOG.md` },
  };
  const script = {
    tool_name: 'Bash',
    cwd: ELSEWHERE,
    tool_input: { command: `node -e "require('fs').writeFileSync('${ROOT}/x.md', 'a')"` },
  };
  assert.equal(policy.writesUnder(redirect, ROOT), true);
  assert.equal(policy.writesUnder(script, ROOT), true);
});

test('writesUnder: an app session editing its own files with the repo in a heredoc is not refused', () => {
  const cmd = `cat > CHANGELOG.md <<'EOF'\n- fixed per build-policy 2.59\nEOF`;
  const input = { tool_name: 'Bash', cwd: ELSEWHERE, tool_input: { command: cmd } };
  assert.equal(policy.writesUnder(input, ROOT), false);
});

test('commandNamesRoot: real path yes, sibling public mirror no, relative only when it resolves', () => {
  assert.equal(policy.commandNamesRoot(`cat ${ROOT}/README.md`, ROOT), true);
  assert.equal(policy.commandNamesRoot(`cat ${ROOT}-public/README.md`, ROOT), false);
  assert.equal(
    policy.commandNamesRoot('cat ../build-policy/README.md', ROOT, path.join(PARENT, 'some-app')),
    true,
  );
  assert.equal(
    policy.commandNamesRoot(
      'cat ../build-policy/README.md',
      ROOT,
      path.join(ELSEWHERE, 'some-app'),
    ),
    false,
  );
});

test('literalPathsUnder: whole path literals count, sentences do not', () => {
  assert.equal(
    policy.literalPathsUnder(`fs.writeFileSync('${ROOT}/x.md', 'a')`, ROOT, ELSEWHERE),
    true,
  );
  assert.equal(
    policy.literalPathsUnder(`console.log('the ${ROOT} repo holds the policy')`, ROOT, ELSEWHERE),
    false,
  );
});

test('splitStringLiterals: handles quotes, escapes and triple quotes', () => {
  const { literals, code } = policy.splitStringLiterals(`a('x\\'y') + b("z") + """doc""" + c`);
  assert.deepEqual(literals, ["x\\'y", 'z', 'doc']);
  assert.match(code, /a\(\s*\) \+ b\(\s*\) \+\s+\+ c/);
});

test('cmpSemver: numeric, not lexical', () => {
  assert.ok(policy.cmpSemver('2.10', '2.9') > 0);
  assert.ok(policy.cmpSemver('2.4.4', '2.4.3') > 0);
  assert.equal(policy.cmpSemver('2.60', '2.60'), 0);
});

test('brewAttestationsOn: presence-based, and the NO_ variable wins', () => {
  assert.equal(policy.brewAttestationsOn({ HOMEBREW_VERIFY_ATTESTATIONS: '1' }), true);
  assert.equal(policy.brewAttestationsOn({ HOMEBREW_VERIFY_ATTESTATIONS: 'false' }), true);
  assert.equal(
    policy.brewAttestationsOn({
      HOMEBREW_VERIFY_ATTESTATIONS: '1',
      HOMEBREW_NO_VERIFY_ATTESTATIONS: '1',
    }),
    false,
  );
  assert.equal(policy.brewAttestationsOn({}), false);
});

test('gated files: dependency manifests and source, not docs or tests', () => {
  assert.equal(policy.isGatedFile('package-lock.json'), true);
  assert.equal(policy.isGatedFile('server/package.json'), true);
  assert.equal(policy.isGatedFile('src/App.tsx'), true);
  assert.equal(policy.isGatedFile('README.md'), false);
  assert.equal(policy.isSourceFile('tests/smoke.js'), false);
});

test('model regexes: thinking-off detection and the models that reject it', () => {
  assert.match("thinking: { type: 'disabled' }", policy.THINKING_DISABLED_RE);
  assert.doesNotMatch("type: 'adaptive'", policy.THINKING_DISABLED_RE);
  assert.match("model: 'claude-sonnet-5-5'", policy.NO_DISABLE_MODEL_RE);
  assert.match("'claude-opus-5-5'", policy.NO_DISABLE_MODEL_RE);
  assert.doesNotMatch("'claude-sonnet-5'", policy.NO_DISABLE_MODEL_RE);
  assert.doesNotMatch("'claude-opus-5'", policy.NO_DISABLE_MODEL_RE);
  // Haiku 5.5 thinks by default but still accepts `disabled` at effort high or below.
  assert.match("'claude-haiku-5-5'", policy.THINKING_DEFAULT_MODEL_RE);
  assert.doesNotMatch("'claude-haiku-4-5'", policy.THINKING_DEFAULT_MODEL_RE);
  assert.doesNotMatch("'claude-haiku-5-5'", policy.NO_DISABLE_MODEL_RE);
  // Sampling parameters: a 400 on the 5.5 generation, accepted on Haiku 4.5.
  assert.match("'claude-haiku-5-5'", policy.NO_SAMPLING_MODEL_RE);
  assert.match("'claude-sonnet-5-5'", policy.NO_SAMPLING_MODEL_RE);
  assert.doesNotMatch("'claude-haiku-4-5'", policy.NO_SAMPLING_MODEL_RE);
  assert.doesNotMatch("'claude-sonnet-5'", policy.NO_SAMPLING_MODEL_RE);
  assert.match('      temperature: 0.2,', policy.SAMPLING_PARAM_RE);
  assert.match('temperature=0', policy.SAMPLING_PARAM_RE);
  assert.match('top_p: 0.9', policy.SAMPLING_PARAM_RE);
  assert.doesNotMatch("label: 'Temperature'", policy.SAMPLING_PARAM_RE);
  assert.doesNotMatch('const temperature = settings.temperature;', policy.SAMPLING_PARAM_RE);
  assert.match('const t = msg.content[0].text', policy.FIRST_BLOCK_TEXT_RE);
  assert.match('msg.content?.[0]?.text', policy.FIRST_BLOCK_TEXT_RE);
});

test('historyRows: versions in table order, non-row lines ignored', () => {
  const table =
    '| Version | Date | Changes |\n|---|---|---|\n| 2.61 | 2026-10-06 | a |\n| 2.60 | 2026-10-05 | b |\n| 2.4.4 | 2026-08-18 | c |\nprose | 1.0 | not a row\n';
  assert.deepEqual(policy.historyRows(table), ['2.61', '2.60', '2.4.4']);
});

test('shippedDmgVersions: test builds under distribution none are not shipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-dmg-'));
  fs.mkdirSync(path.join(dir, 'release'));
  fs.writeFileSync(path.join(dir, 'release', 'App-0.1.0-universal.dmg'), '');
  const none = { isElectron: true, pkg: { version: '0.1.0', policy: { distribution: 'none' } } };
  const gumroad = { isElectron: true, pkg: { version: '0.1.0', policy: { distribution: 'gumroad' } } };
  const inferred = { isElectron: true, pkg: { version: '0.1.0' } };
  assert.equal(policy.releaseProfile(none), 'none');
  assert.equal(policy.releaseProfile(inferred), 'gumroad');
  assert.equal(policy.shippedDmgVersions(dir, none).size, 0);
  assert.deepEqual([...policy.shippedDmgVersions(dir, gumroad)], ['0.1.0']);
  assert.deepEqual([...policy.shippedDmgVersions(dir, inferred)], ['0.1.0']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('secret scans: staged diff at pre-commit, history in the full run', () => {
  const { GATE_ORDER, BASE_SCRIPTS, STANDARD_SCRIPTS } = policy;
  const fastSet = GATE_ORDER.filter((g) => g.fast).map((g) => g.script);
  const fullSet = GATE_ORDER.filter((g) => !g.fastOnly).map((g) => g.script);
  assert.ok(fastSet.includes('secrets:staged'), 'pre-commit subset scans the stage');
  assert.ok(!fastSet.includes('secrets'), 'history scan is not in the pre-commit subset');
  assert.ok(fullSet.includes('secrets'), 'full run scans history');
  assert.ok(!fullSet.includes('secrets:staged'), 'full run does not repeat the staged scan');
  assert.ok(BASE_SCRIPTS.includes('secrets:staged'), 'secrets:staged is a required script');
  assert.match(STANDARD_SCRIPTS['secrets:staged'], /betterleaks git .*--staged/);
  assert.match(STANDARD_SCRIPTS.secrets, /betterleaks git \./);
  for (const s of [STANDARD_SCRIPTS.secrets, STANDARD_SCRIPTS['secrets:staged']])
    assert.match(s, /(?:^|\s)--redact(?=\s|$)/, `standard command lacks --redact: ${s}`);
  const { SECRET_SCAN_LEAKY_FLAG_RE: leaky } = policy;
  for (const s of [STANDARD_SCRIPTS.secrets, STANDARD_SCRIPTS['secrets:staged']])
    assert.ok(!leaky.test(s), `standard command carries a leaky flag: ${s}`);
  for (const s of [
    'betterleaks git . -v',
    'betterleaks git --pre-commit --staged -v',
    'betterleaks git . --validation',
    'betterleaks fs . --validate',
    'betterleaks fs . -a',
    'betterleaks git . --verbose',
  ])
    assert.ok(leaky.test(s), `leaky flag missed: ${s}`);
  for (const s of ['betterleaks git . --redact', 'betterleaks git . --no-verbose', 'betterleaks git ./my-vault'])
    assert.ok(!leaky.test(s), `false positive: ${s}`);
});

test('secret report locations: file, line and rule, never the value', () => {
  const { secretReportLocations } = policy;
  const findings = [
    { File: 'server/ai.js', StartLine: 12, RuleID: 'github-pat', Secret: 'REDACTED', Match: 'REDACTED' },
    { File: '.env.local', StartLine: 3, RuleID: 'generic-api-key', Secret: 'REDACTED' },
    { Description: 'no File field' },
  ];
  const out = secretReportLocations(findings);
  assert.deepEqual(out, ['server/ai.js:12 (github-pat)', '.env.local:3 (generic-api-key)']);
  assert.ok(!out.join('\n').includes('REDACTED'), 'the value field is never echoed');
  const hostile = secretReportLocations([{ File: 'a\x1b[2Kb\nc.js', StartLine: 1, RuleID: 'x\x07y' }]);
  assert.deepEqual(hostile, ['a\\x1b[2Kb\\x0ac.js:1 (x\\x07y)'], 'control characters are escaped');
  assert.deepEqual(secretReportLocations(null), []);
  assert.deepEqual(secretReportLocations({ not: 'an array' }), []);
});

test('footerBannerFindings: rights wording, Terms link and per-version dismissal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-footer-'));
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  const run = (opts) =>
    policy.footerBannerFindings(dir, { termsUrl: 'https://example.com/terms/', ...opts });

  // Close button that only clears state: no remembered version, so it fails.
  write('src/App.tsx', `<p>© 2026 Example. All rights reserved.</p>\n<button onClick={() => setUpdate(null)}>×</button>`);
  let f = run({ distributes: true, versionCheck: 'src/App.tsx' });
  assert.equal(f.length, 3);
  assert.match(f[0], /src\/App\.tsx: says "All rights reserved"/);
  assert.match(f[1], /no Terms link/);
  assert.match(f[2], /cannot be dismissed per version/);

  // Fixed: Terms in the footer, per-version dismissal, the wording only in a
  // comment and a test (neither is UI).
  write(
    'src/App.tsx',
    `// Drop "All rights reserved" (Berne)\n<a href="https://example.com/terms/">Terms</a>\n{latest && latest !== dismissedVersion && <Banner/>}`,
  );
  write('tests/footer.test.ts', `expect(text).not.toContain('All rights reserved')`);
  assert.deepEqual(run({ distributes: true, versionCheck: 'src/App.tsx' }), []);

  // Flat app: rights wording in index.html is found.
  write('index.html', `<footer>© 2026 Example — All Rights Reserved</footer>`);
  assert.match(run({ distributes: true, versionCheck: 'src/App.tsx' })[0], /^index\.html: says/);
  fs.rmSync(path.join(dir, 'index.html'));

  // No termsUrl in the registry (null, as in the public mirror): any /terms/ link counts.
  assert.deepEqual(policy.footerBannerFindings(dir, { distributes: true, versionCheck: null, termsUrl: null }), []);
  write('src/App.tsx', `<p>v1</p>`);
  assert.match(policy.footerBannerFindings(dir, { distributes: true, versionCheck: null, termsUrl: null })[0], /the site's \/terms\/ page/);

  // Terms owed only once the app distributes; dismissal only with a banner.
  fs.writeFileSync(path.join(dir, 'src/App.tsx'), `<p>v1</p>`);
  assert.deepEqual(run({ distributes: false, versionCheck: null }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DISMISS_PER_VERSION_RE: the shapes the apps use, not a bare dismiss', () => {
  for (const ok of [
    'if (latest === dismissedVersion) return null;',
    'dismissed === latest',
    "localStorage.getItem('dismissedUpdateVersion') === data.version",
    'setDismissed(localStorage.getItem(DISMISSED_KEY) === site)',
    'dismissedUpdateVersion !== updateAvailable.version',
    'updateVersion !== dismissedVersion',
  ])
    assert.match(ok, policy.DISMISS_PER_VERSION_RE, ok);
  for (const bad of ['onClick={dismiss}', 'const [dismissed, setDismissed] = useState(false)', 'x === y'])
    assert.doesNotMatch(bad, policy.DISMISS_PER_VERSION_RE, bad);
});
