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
