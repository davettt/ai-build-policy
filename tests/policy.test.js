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
  // The relative form names the repo by its folder name, which is whatever the
  // running copy is called (the public mirror is one such copy).
  const rel = `cat ../${path.basename(ROOT)}/README.md`;
  assert.equal(policy.commandNamesRoot(rel, ROOT, path.join(PARENT, 'some-app')), true);
  assert.equal(policy.commandNamesRoot(rel, ROOT, path.join(ELSEWHERE, 'some-app')), false);
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
  const gumroad = {
    isElectron: true,
    pkg: { version: '0.1.0', policy: { distribution: 'gumroad' } },
  };
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
  for (const s of [
    'betterleaks git . --redact',
    'betterleaks git . --no-verbose',
    'betterleaks git ./my-vault',
  ])
    assert.ok(!leaky.test(s), `false positive: ${s}`);
});

test('secret report locations: file, line and rule, never the value', () => {
  const { secretReportLocations } = policy;
  const findings = [
    {
      File: 'server/ai.js',
      StartLine: 12,
      RuleID: 'github-pat',
      Secret: 'REDACTED',
      Match: 'REDACTED',
    },
    { File: '.env.local', StartLine: 3, RuleID: 'generic-api-key', Secret: 'REDACTED' },
    { Description: 'no File field' },
  ];
  const out = secretReportLocations(findings);
  assert.deepEqual(out, ['server/ai.js:12 (github-pat)', '.env.local:3 (generic-api-key)']);
  assert.ok(!out.join('\n').includes('REDACTED'), 'the value field is never echoed');
  const hostile = secretReportLocations([
    { File: 'a\x1b[2Kb\nc.js', StartLine: 1, RuleID: 'x\x07y' },
  ]);
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
  write(
    'src/App.tsx',
    `<p>© 2026 Example. All rights reserved.</p>\n<button onClick={() => setUpdate(null)}>×</button>`,
  );
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
  assert.deepEqual(
    policy.footerBannerFindings(dir, { distributes: true, versionCheck: null, termsUrl: null }),
    [],
  );
  write('src/App.tsx', `<p>v1</p>`);
  assert.match(
    policy.footerBannerFindings(dir, { distributes: true, versionCheck: null, termsUrl: null })[0],
    /the site's \/terms\/ page/,
  );

  // Terms owed only once the app distributes; dismissal only with a banner.
  fs.writeFileSync(path.join(dir, 'src/App.tsx'), `<p>v1</p>`);
  assert.deepEqual(run({ distributes: false, versionCheck: null }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remoteFontFindings: a Google Fonts link, @import or CSP allowance; bundled fonts and opt-outs pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-fonts-'));
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  // The three shapes the sweep found: <link> in index.html, a helmet fontSrc
  // allowance in the server, and an @import in a stylesheet.
  write(
    'index.html',
    `<link rel="preconnect" href="https://fonts.googleapis.com" />\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n<link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet" />`,
  );
  write('server/index.js', `fontSrc: ['https://fonts.gstatic.com'],`);
  write('src/index.css', `@import url('https://fonts.googleapis.com/css2?family=Inter');`);
  assert.deepEqual(policy.remoteFontFindings(dir), [
    'index.html (3 lines)',
    'server/index.js (1 line)',
    'src/index.css (1 line)',
  ]);

  // Fixed: bundled files, font-src 'self', the host only in a comment, a
  // test fixture, and an analyzer line that opts out.
  write('index.html', `<!-- fonts bundled; was fonts.googleapis.com -->\n<title>App</title>`);
  write('server/index.js', `// no fonts.gstatic.com: fonts are bundled\nfontSrc: ["'self'"],`);
  write(
    'src/index.css',
    `@font-face { font-family: 'Inter'; src: url('/fonts/inter-latin-wght-normal.woff2') format('woff2-variations'); }`,
  );
  write('tests/analyzer.test.js', `expect(hosts).toContain('fonts.googleapis.com')`);
  write(
    'src/analyzer.js',
    `const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']; // policy:names-font-host`,
  );
  assert.deepEqual(policy.remoteFontFindings(dir), []);

  // The opt-out covers its own line only.
  write(
    'src/analyzer.js',
    `// policy:names-font-host\nconst FONT_HOSTS = ['fonts.googleapis.com'];`,
  );
  assert.deepEqual(policy.remoteFontFindings(dir), ['src/analyzer.js (1 line)']);
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
  for (const bad of [
    'onClick={dismiss}',
    'const [dismissed, setDismissed] = useState(false)',
    'x === y',
  ])
    assert.doesNotMatch(bad, policy.DISMISS_PER_VERSION_RE, bad);
});

test('template drift and leaky-script fixes name sync-templates, never a cp or rm', () => {
  assert.match(policy.TEMPLATE_SYNC_HINT, /policy sync-templates \./);
  assert.doesNotMatch(policy.TEMPLATE_SYNC_HINT, /\b(cp|rm|delete)\b/);
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'policy.js'), 'utf8');
  for (const m of src.match(/`[^`]*differs from the shared template[^`]*`/g) || [])
    assert.match(m, /TEMPLATE_SYNC_HINT/, m);
});

test('secretScriptSyncs: rewrites a drifted or missing secret-scan script, leaves the standard alone', () => {
  const std = policy.STANDARD_SCRIPTS;
  assert.deepEqual(
    policy.secretScriptSyncs({ secrets: std.secrets, 'secrets:staged': std['secrets:staged'] }),
    {},
  );
  assert.deepEqual(
    policy.secretScriptSyncs({
      secrets: 'gitleaks detect --source . --verbose',
      'secrets:staged': std['secrets:staged'],
    }),
    {
      secrets: std.secrets,
    },
  );
  assert.deepEqual(policy.secretScriptSyncs({ secrets: 'betterleaks git . --redact -v' }), {
    secrets: std.secrets,
    'secrets:staged': std['secrets:staged'],
  });
  assert.deepEqual(policy.secretScriptSyncs(undefined), {
    secrets: std.secrets,
    'secrets:staged': std['secrets:staged'],
  });
});

test('GATE_ORDER: the code review is the last gate, after build and every test tier', () => {
  const { GATE_ORDER } = policy;
  const scripts = GATE_ORDER.map((g) => g.script);
  assert.equal(scripts[scripts.length - 1], 'review');
  assert.equal(GATE_ORDER[GATE_ORDER.length - 1].name, 'Code review');
  for (const s of ['build', 'test:unit', 'test:smoke', 'test:integration', 'test:flows'])
    assert.ok(scripts.indexOf(s) < scripts.indexOf('review'), `${s} runs before the review`);
});

// Reviewer selection (2.71). A temp git repo with real files, because the
// security-sensitive check reads content and the diff builder calls git.
function reviewFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-reviewer-'));
  require('child_process').execSync('git init -q && git commit -q --allow-empty -m base', {
    cwd: dir,
  });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  return dir;
}
const small = 'export const a = 1;\n'.repeat(10);
const choose = (dir, files, extra = {}) =>
  policy.chooseReviewer(dir, { workFiles: Object.keys(files), hasClaude: true, ...extra });

test('chooseReviewer: an ordinary renderer change goes to claude, with the size in the reason', () => {
  const files = { 'src/components/Button.tsx': small };
  const dir = reviewFixture(files);
  const r = choose(dir, files);
  assert.equal(r.reviewer, 'claude');
  assert.match(r.reason, /1 source file, 10 changed lines/);
});

test('chooseReviewer: a security-sensitive path or call escalates to coderabbit', () => {
  const byPath = { 'src/auth.ts': small };
  assert.deepEqual(choose(reviewFixture(byPath), byPath), {
    reviewer: 'coderabbit',
    reason: 'security-sensitive: src/auth.ts',
  });
  const byContent = { 'src/routes.ts': 'app.use(cors());\n' };
  assert.equal(choose(reviewFixture(byContent), byContent).reviewer, 'coderabbit');
});

test('chooseReviewer: dependency manifests, main-process code and migrations escalate', () => {
  for (const [f, body] of [
    ['package-lock.json', '{}'],
    ['electron/main.ts', small],
    ['src/main/index.ts', small],
    ['server/routes.js', small],
    ['src/db/migrations/0003.ts', small],
  ]) {
    const files = { 'src/components/Button.tsx': small, [f]: body };
    const r = choose(reviewFixture(files), files);
    assert.equal(r.reviewer, 'coderabbit', `${f}: ${r.reason}`);
  }
});

test('chooseReviewer: a large diff escalates; the project can raise the limit', () => {
  const files = { 'src/components/Big.tsx': 'export const a = 1;\n'.repeat(600) };
  const dir = reviewFixture(files);
  assert.match(choose(dir, files).reason, /600 changed lines \(Claude limit 400\)/);
  assert.equal(
    choose(dir, files, { pkg: { policy: { review: { maxClaudeLines: 1000 } } } }).reviewer,
    'claude',
  );
  assert.equal(
    choose(dir, files, { pkg: { policy: { review: { escalatePaths: ['^src/components/'] } } } })
      .reviewer,
    'coderabbit',
  );
});

test('chooseReviewer: flags, release and first commit override the diff; a bad flag is refused', () => {
  const files = { 'src/components/Button.tsx': small };
  const dir = reviewFixture(files);
  assert.equal(choose(dir, files, { flags: ['--with-review'] }).reviewer, 'coderabbit');
  assert.equal(choose(dir, files, { flags: ['--reviewer=coderabbit'] }).reviewer, 'coderabbit');
  assert.equal(choose(dir, files, { release: true }).reason, 'release');
  assert.equal(choose(dir, files, { rootReview: true }).reviewer, 'coderabbit');
  assert.equal(choose(dir, files, { hasClaude: false }).reason, 'claude CLI not installed');
  const sensitive = { 'src/auth.ts': small };
  assert.equal(
    choose(reviewFixture(sensitive), sensitive, { flags: ['--reviewer=claude'] }).reviewer,
    'claude',
  );
  assert.equal(choose(dir, files, { flags: ['--reviewer=gpt'] }).reviewer, null);
});

test('reviewConfig: invalid tuning is reported and ignored, never fatal', () => {
  const cfg = policy.reviewConfig({
    policy: { review: { escalatePaths: ['(unclosed'], maxClaudeLines: -1 } },
  });
  assert.equal(cfg.errors.length, 2);
  assert.equal(cfg.maxClaudeLines, policy.REVIEW_MAX_CLAUDE_LINES);
  assert.equal(cfg.escalatePaths.length, policy.REVIEW_ESCALATE_PATHS.length);
  assert.deepEqual(policy.reviewConfig(null).errors, []);
});

test('normalizeValueFlags/flagValue: --reviewer claude is read as a value, not as the project dir', () => {
  const rest = policy.normalizeValueFlags(['gates', '--reviewer', 'claude', '.'], ['--reviewer']);
  assert.deepEqual(rest, ['gates', '--reviewer=claude', '.']);
  assert.equal(policy.flagValue(rest, '--reviewer'), 'claude');
  assert.equal(policy.flagValue(['--fast'], '--reviewer'), null);
  assert.deepEqual(policy.normalizeValueFlags(['--reviewer', '--fast'], ['--reviewer']), [
    '--reviewer',
    '--fast',
  ]);
});

test('hook source: the --reviewer refusal tolerates no spelling of claude but a bare coderabbit', () => {
  // The hook runs as a process on stdin JSON, so the predicate is read out of
  // the source and exercised here the way bashWriteTargets is above.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'policy.js'), 'utf8');
  const m = src.match(
    /\/(policy\\\.js\[.*?--reviewer\\b)\/\.test\(cmd\) &&\s*!\/(--reviewer\[=\\s\]\+coderabbit[^/]*)\/\.test\(cmd\)/,
  );
  assert.ok(m, 'refusal predicate present');
  const flag = new RegExp(m[1]);
  const allowed = new RegExp(m[2]);
  const refused = (cmd) => flag.test(cmd) && !allowed.test(cmd);
  for (const c of [
    'node ../build-policy/scripts/policy.js gates --reviewer claude',
    'node ../build-policy/scripts/policy.js gates --reviewer=claude .',
    'node ../build-policy/scripts/policy.js gates --reviewer  claude',
    'node ../build-policy/scripts/policy.js gates --reviewer "claude"',
    "node ../build-policy/scripts/policy.js gates --reviewer='claude'",
    'node ../build-policy/scripts/policy.js gates --reviewer=$(echo claude)',
    'node ../build-policy/scripts/policy.js gates --reviewer',
  ])
    assert.ok(refused(c), `refused: ${c}`);
  for (const c of [
    'node ../build-policy/scripts/policy.js gates --reviewer coderabbit',
    'node ../build-policy/scripts/policy.js gates --reviewer=coderabbit .',
    'node ../build-policy/scripts/policy.js gates --with-review',
    'node ../build-policy/scripts/policy.js gates',
  ])
    assert.ok(!refused(c), `allowed: ${c}`);
});

test('judgeClaudeReview: findings decide; a missing, erroring or malformed result fails', () => {
  const j = policy.judgeClaudeReview;
  const out = (findings, verdict = 'pass') => ({
    is_error: false,
    structured_output: { verdict, findings },
  });
  const f = (severity) => ({ severity, file: 'a.js', title: 't', detail: 'd' });
  assert.equal(j(out([f('low'), f('medium')], 'fail')).pass, true);
  assert.equal(j(out([f('high')])).pass, false);
  assert.equal(j(out([f('critical')], 'pass')).pass, false);
  assert.equal(j(out([])).pass, true);
  assert.equal(j(null).pass, false);
  assert.match(j({ is_error: true, result: 'Not logged in' }).error, /Not logged in/);
  assert.equal(j({ is_error: false, result: 'plain text' }).pass, false);
  assert.equal(
    j({ is_error: false, structured_output: { verdict: 'maybe', findings: [] } }).pass,
    false,
  );
});

test('reviewerOf: new markers name their reviewer; pre-2.71 records read as coderabbit', () => {
  const r = policy.reviewerOf;
  assert.equal(
    r({ gates: ['Build', 'Code review'], review: { reviewer: 'claude', reason: 'x' } }),
    'claude',
  );
  assert.equal(
    r({ gates: ['Build', 'Code review'], review: { reviewer: 'coderabbit' } }),
    'coderabbit',
  );
  assert.equal(r({ gates: ['Build', 'CodeRabbit review'] }), 'coderabbit');
  assert.equal(r({ reviewedSourceHash: 'abc', head: 'h' }), 'coderabbit');
  assert.equal(r({ reviewedSourceHash: 'abc', reviewer: 'claude' }), 'claude');
  assert.equal(r({ gates: ['Build'] }), null);
  assert.equal(r(null), null);
});

test('offTrunkBranch: null on main or master or outside git, the branch name otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-branch-'));
  assert.equal(policy.offTrunkBranch(dir), null);
  const git = (args) =>
    require('child_process').execSync(`git ${args}`, { cwd: dir, stdio: 'pipe' }).toString();
  git('init -q -b main');
  git('-c user.email=t -c user.name=t commit -q --allow-empty -m root');
  assert.equal(policy.offTrunkBranch(dir), null);
  git('switch -q -c dev-fonts');
  assert.equal(policy.offTrunkBranch(dir), 'dev-fonts');
  git('switch -q -c master');
  assert.equal(policy.offTrunkBranch(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('repoHasNoCommits: true after git init, false after the root commit, false outside git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-root-'));
  const git = (args) =>
    require('child_process').execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  assert.equal(policy.repoHasNoCommits(dir), false);
  git(['init', '-q']);
  assert.equal(policy.repoHasNoCommits(dir), true);
  git([
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@localhost',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'root',
  ]);
  assert.equal(policy.repoHasNoCommits(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit approvals: bound to the project, so a copied approval does not count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-audit-'));
  const e = { package: 'p', via: 'q', reason: 'r', decided: '2026-10-01', expires: '2026-12-01' };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'this-site' }));
  fs.writeFileSync(path.join(dir, 'audit-exceptions.json'), JSON.stringify({ 'GHSA-x': e }));
  // Test fixture only: writes the approvals file in a temp dir to exercise the predicate.
  const approve = (rec) =>
    fs.writeFileSync(path.join(dir, 'audit-approvals.json'), JSON.stringify({ 'GHSA-x': rec }));
  const hash = policy.auditEntryHash(e);
  assert.equal(policy.auditProjectId(dir), 'this-site');
  // Legacy (no project) or copied from another project: not approved here.
  for (const [rec, why] of [
    [{ hash }, /approve it again/],
    [{ hash, project: 'starter' }, /not this one/],
  ]) {
    approve(rec);
    assert.equal(policy.auditExceptionApproved(dir, 'GHSA-x', e), false);
    assert.match(policy.auditApprovalMismatch(dir, 'GHSA-x', e), why);
  }
  approve({ hash: 'stale', project: 'this-site' });
  assert.equal(policy.auditExceptionApproved(dir, 'GHSA-x', e), false);
  assert.match(policy.auditApprovalMismatch(dir, 'GHSA-x', e), /changed since/);
  approve({ hash, project: 'this-site' });
  assert.equal(policy.auditExceptionApproved(dir, 'GHSA-x', e), true);
  assert.equal(policy.auditApprovalMismatch(dir, 'GHSA-x', e), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatAuditEntry: the reason reads as wrapped prose with the facts beside it', () => {
  const e = {
    package: 'http-cache-semantics',
    via: 'astro',
    reason: 'word '.repeat(40).trim(),
    decided: '2026-10-10',
    expires: '2026-12-31',
  };
  const out = policy.formatAuditEntry('GHSA-x', e, 'this-site').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /^GHSA-x  http-cache-semantics \(reached through astro\)/);
  assert.match(out, /not to apply to this-site/);
  assert.match(out, /Decided 2026-10-10, expires 2026-12-31\./);
  for (const line of out.split('\n')) assert.ok(line.length <= 82, line);
  assert.equal(policy.wrapText('a b c', 3, '> '), '> a b\n> c');
});

test('unpresentedExceptions: an unapproved entry counts as presented only when the reply carries its reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-present-'));
  const e = {
    package: 'p',
    via: 'q',
    reason: 'Only reached when remote  images are configured; none are.',
    decided: '2026-10-01',
    expires: '2026-12-01',
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'site' }));
  fs.writeFileSync(path.join(dir, 'audit-exceptions.json'), JSON.stringify({ 'GHSA-x': e }));
  assert.deepEqual(policy.unpresentedExceptions(dir, 'Run the approve command.'), ['GHSA-x']);
  assert.deepEqual(policy.unpresentedExceptions(dir, null), ['GHSA-x']);
  // Whitespace and wrapping in the reply do not matter.
  assert.deepEqual(
    policy.unpresentedExceptions(
      dir,
      'Here it is:\n  Only reached when remote images are\n  configured; none are.\nThen run it.',
    ),
    [],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lastAssistantText: the final assistant text block in a transcript', () => {
  const f = path.join(os.tmpdir(), `policy-transcript-${process.pid}.jsonl`);
  fs.writeFileSync(
    f,
    [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first' }] },
      }),
      'not json',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use' }, { type: 'text', text: 'last' }] },
      }),
    ].join('\n'),
  );
  assert.equal(policy.lastAssistantText(f), 'last');
  assert.equal(policy.lastAssistantText(f + '.missing'), null);
  fs.rmSync(f, { force: true });
});

test('every message that hands the developer the approve command names --confirm', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'policy.js'), 'utf8');
  const sites = src.match(/approve-exception \$\{[^}]+\}[^`'\n]*/g) || [];
  assert.ok(
    sites.length >= 3,
    `expected the check, Stop hook and first-step sites, found ${sites.length}`,
  );
  for (const s of sites) assert.match(s, /--confirm/, s);
  assert.match(src, /approve-exception <GHSA-id> --confirm/);
});

test('helpPagesStatus: pages are read from the app side by slug or source, pending by minor or newer source', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-help-'));
  const app = path.join(parent, 'app-one');
  const help = path.join(parent, 'helpsite');
  const docs = path.join(help, 'src', 'content', 'docs', 'product');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(help, 'package.json'), '{"name":"helpsite"}');
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"app-one","version":"2.1.0"}');
  fs.writeFileSync(path.join(app, 'src', 'App.tsx'), 'export {}');
  const git = (args) =>
    require('child_process').execFileSync('git', args, { cwd: app, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'root']);
  // Local date, as git's %cs prints it: the UTC date can be a day behind.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const page = (name, fm) =>
    fs.writeFileSync(path.join(docs, name), `---\n${fm}\n---\n# ${name}\n`);
  // Matched by a source path under the repo folder; the slug differs from the folder.
  page(
    'current.mdx',
    `app: product\nverifiedVersion: 2.1.0\nlastVerified: ${today}\nsources:\n  - app-one/src/App.tsx`,
  );
  page(
    'old-minor.mdx',
    `app: app-one\nverifiedVersion: 2.0.4\nlastVerified: ${today}\nsources: []`,
  );
  page(
    'stale-source.mdx',
    `app: app-one\nverifiedVersion: 2.1.0\nlastVerified: 2020-01-01\nsources:\n  - app-one/src/App.tsx`,
  );
  page(
    'gone-source.mdx',
    `app: app-one\nverifiedVersion: 2.1.0\nlastVerified: ${today}\nsources:\n  - app-one/src/Gone.tsx`,
  );
  page(
    'other-app.mdx',
    `app: other\nverifiedVersion: 1.0.0\nlastVerified: ${today}\nsources:\n  - other/src/App.tsx`,
  );

  const fm = policy.helpPageFrontMatter(path.join(docs, 'current.mdx'));
  assert.deepEqual(fm, {
    app: 'product',
    verifiedVersion: '2.1.0',
    lastVerified: today,
    sources: ['app-one/src/App.tsx'],
  });

  assert.equal(policy.helpPagesStatus(app, { helpProject: 'missing' }), null);
  const s = policy.helpPagesStatus(app, { helpProject: 'helpsite' });
  assert.equal(s.pages.length, 4, s.pages.join(','));
  assert.deepEqual(s.verified.sort(), ['2.0.4', '2.1.0']);
  assert.equal(s.pending.length, 3, s.pending.join('\n'));
  const pending = s.pending.join('\n');
  assert.match(pending, /old-minor\.mdx: checked against 2\.0\.4, app is now 2\.1\.0/);
  assert.match(pending, /stale-source\.mdx: app-one\/src\/App\.tsx changed after 2020-01-01/);
  assert.match(pending, /gone-source\.mdx: source app-one\/src\/Gone\.tsx no longer exists/);

  const handoff = policy.helpHandoffMessage(app, { pkg: { version: '2.1.0' } }, s);
  assert.match(handoff, /help-handback app-one/);
  assert.match(handoff, /docs:capture in \.\.\/app-one/);
  const back = policy.helpHandbackMessage('app-one', '2.1.0', s, today, 'helpsite', 'abc1234');
  assert.match(back, /^Help pages ready for app-one 2\.1\.0/);
  assert.match(back, /verify-ready --release, then prep the release marketing drafts/);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('HELP_CAPTURE_INVOCATION: a capture as a command word, not a mention', () => {
  const re = policy.HELP_CAPTURE_INVOCATION;
  for (const cmd of [
    'npm run docs:capture',
    'cd ../app-one && npm run docs:capture',
    'npm --prefix ../app-one run docs:capture',
    'npm run build; yarn docs:capture',
  ])
    assert.ok(re.test(cmd), cmd);
  for (const cmd of ['grep docs:capture package.json', 'cat docs/capture.md', 'npm run test:flows'])
    assert.ok(!re.test(cmd), cmd);
});

test('fixableAdvisories: high/critical with an in-range fix only; majors and moderates are left out', () => {
  const audit = {
    vulnerabilities: {
      concurrently: { severity: 'critical', isDirect: true, fixAvailable: true },
      'shell-quote': { severity: 'critical', isDirect: false, fixAvailable: true },
      'electron-builder': {
        severity: 'high',
        isDirect: true,
        fixAvailable: { name: 'electron-builder', version: '26.5.0', isSemVerMajor: true },
      },
      'fast-uri': { severity: 'moderate', isDirect: false, fixAvailable: true },
      braces: { severity: 'high', isDirect: false, fixAvailable: false },
      'brace-expansion': { severity: 'high', isDirect: false, fixAvailable: true },
    },
  };
  assert.deepEqual(
    policy.fixableAdvisories(audit).map((f) => `${f.name}:${f.severity}`),
    ['concurrently:critical', 'shell-quote:critical', 'brace-expansion:high'],
  );
  assert.deepEqual(policy.fixableAdvisories({}), []);
  assert.deepEqual(policy.fixableAdvisories(null), []);
});

test('supersededDependabotPrs: the lockfile at or past the offered version supersedes the PR', () => {
  const prs = [
    { number: 22, title: 'Bump @radix-ui/react-tooltip from 1.2.14 to 1.2.15' },
    { number: 9, title: 'Bump eslint-plugin-react-refresh from 0.5.2 to 0.5.3' },
    { number: 30, title: 'Bump lucide-react from 1.16.0 to 1.25.0' },
    { number: 31, title: 'Bump the radix group with 4 updates' },
    { number: 32, title: 'Bump unknown-pkg from 1.0.0 to 1.0.1' },
  ];
  const lock = {
    'node_modules/@radix-ui/react-tooltip': { version: '1.2.16' },
    'node_modules/eslint-plugin-react-refresh': { version: '0.5.3' },
    'node_modules/lucide-react': { version: '1.16.0' },
  };
  const r = policy.supersededDependabotPrs(prs, lock);
  assert.deepEqual(
    r.superseded.map((p) => [p.number, p.installed]),
    [
      [22, '1.2.16'],
      [9, '0.5.3'],
    ],
  );
  assert.deepEqual(
    r.open.map((p) => p.number),
    [30, 31, 32],
  );
  assert.equal(
    policy.parseDependabotTitle('build(deps-dev): bump vite from 7.1.0 to 7.1.2').name,
    'vite',
  );
  assert.equal(policy.parseDependabotTitle('Bump the radix group with 4 updates'), null);
  assert.ok(policy.semverGte('2.0.0-beta.1', '1.9.9'));
  assert.ok(!policy.semverGte('1.2.9', '1.10.0'));
});

test('supersededDependabotPrs: a posted review moves an open PR to reviewed with its verdict', () => {
  const review = (verdict) => ({
    author: { login: 'owner' },
    body: `@owner\n\n**${verdict}**\n\nBump x 1.0.0 → 1.0.1\n\n**Suggested action**: merge this PR`,
  });
  const prs = [
    { number: 40, title: 'Bump a from 1.0.0 to 1.0.1', comments: [review('CLEAN TO MERGE')] },
    {
      number: 41,
      title: 'Bump b from 1.0.0 to 1.0.1',
      comments: [review('CLEAN TO MERGE'), review('DO NOT MERGE')],
    },
    {
      number: 42,
      title: 'Bump c from 1.0.0 to 1.0.1',
      comments: [{ author: { login: 'owner' }, body: 'Looks fine to me' }],
    },
    {
      number: 45,
      title: 'Bump e from 1.0.0 to 1.0.1',
      comments: [
        { author: { login: 'stranger' }, body: '**CLEAN TO MERGE**\n\nSuggested action: merge' },
      ],
    },
    { number: 43, title: 'Bump d from 1.0.0 to 1.0.1' },
    { number: 44, title: 'Bump a from 1.0.0 to 1.0.1', comments: [review('CLEAN TO MERGE')] },
  ];
  const r = policy.supersededDependabotPrs(
    prs,
    { 'node_modules/a': { version: '1.0.1' } },
    'owner',
  );
  assert.deepEqual(
    r.superseded.map((p) => p.number),
    [40, 44],
  );
  assert.deepEqual(
    r.open.map((p) => p.number),
    [42, 45, 43],
  );
  assert.deepEqual(
    r.reviewed.map((p) => [p.number, p.verdict]),
    [[41, 'DO NOT MERGE']],
  );
  const mine = { author: { login: 'owner' }, body: 'Suggested action: close it' };
  assert.equal(policy.dependabotReviewVerdict([mine], 'owner'), 'reviewed');
  assert.equal(policy.dependabotReviewVerdict([mine], null), null, 'no known login: no verdict');
  assert.equal(
    policy.dependabotReviewVerdict([{ body: 'Suggested action: merge' }], 'owner'),
    null,
  );
  assert.equal(policy.dependabotReviewVerdict([], 'owner'), null);
  assert.equal(policy.dependabotReviewVerdict(undefined, 'owner'), null);
  assert.equal(policy.supersededDependabotPrs(prs, {}, null).reviewed.length, 0);
});

test('isArchived and dependabotPrLimit: read from package.json and dependabot.yml, with defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-archived-'));
  assert.equal(policy.isArchived(dir), false);
  assert.equal(policy.dependabotPrLimit(dir), 5);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","policy":{"archived":true}}');
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.github', 'dependabot.yml'),
    'updates:\n  - open-pull-requests-limit: 10\n',
  );
  assert.equal(policy.isArchived(dir), true);
  assert.equal(policy.dependabotPrLimit(dir), 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify-package: repo name match, sibling maintainers and provenance are pure helpers', () => {
  const vp = require('../scripts/verify-package.js');
  assert.deepEqual(vp.parseGithubRepo('git+https://github.com/expressjs/express.git'), {
    owner: 'expressjs',
    repo: 'express',
  });
  assert.deepEqual(vp.parseGithubRepo('https://github.com/radix-ui/primitives#readme'), {
    owner: 'radix-ui',
    repo: 'primitives',
  });
  assert.equal(vp.parseGithubRepo('https://gitlab.com/a/b'), null);
  assert.equal(
    vp.parseGithubRepo('https://github.com/owner/..'),
    null,
    'path walking owner or repo is refused',
  );
  assert.equal(vp.parseGithubRepo('https://github.com/own%2Fer/repo'), null);
  assert.equal(vp.safeDirectory('packages/react/tooltip'), 'packages/react/tooltip');
  assert.equal(vp.safeDirectory('/types/node/'), 'types/node');
  assert.equal(
    vp.safeDirectory('../../squatter/fake/HEAD'),
    null,
    'a directory cannot leave the repository',
  );
  assert.equal(vp.safeDirectory('a/./b'), null);
  assert.equal(vp.safeDirectory('a?x=1'), null);
  assert.equal(vp.safeDirectory(''), null);
  assert.equal(vp.safeDirectory(undefined), null);
  assert.equal(vp.parseGithubRepo(null), null);

  assert.equal(vp.repoNameMatch('express', { name: 'express' }, null), 'match');
  assert.equal(
    vp.repoNameMatch(
      '@radix-ui/react-tooltip',
      { name: 'primitives', workspaces: ['packages/*'] },
      { name: '@radix-ui/react-tooltip' },
    ),
    'match',
  );
  assert.equal(
    vp.repoNameMatch('evil-express', { name: 'express' }, null),
    'mismatch',
    'squat pointing at a real repo',
  );
  assert.equal(
    vp.repoNameMatch('x', { name: 'root', workspaces: ['packages/*'] }, { name: 'other' }),
    'mismatch',
    'directory given, wrong name',
  );
  assert.equal(
    vp.repoNameMatch('x', { name: 'root', workspaces: ['packages/*'] }, null),
    'monorepo',
  );
  assert.equal(vp.repoNameMatch('x', null, null), 'unknown');
  assert.equal(vp.repoNameMatch('x', {}, null), 'unknown');

  assert.equal(
    vp.sharesMaintainer(
      { maintainers: [{ name: 'a' }, { name: 'b' }] },
      { maintainers: [{ name: 'b' }] },
    ),
    true,
  );
  assert.equal(
    vp.sharesMaintainer({ maintainers: [{ name: 'a' }] }, { maintainers: [{ name: 'b' }] }),
    false,
  );
  assert.equal(vp.sharesMaintainer({ maintainers: [{ name: 'a' }] }, null), false);

  assert.equal(
    vp.hasProvenance({ dist: { attestations: { url: 'u', provenance: { predicateType: 'p' } } } }),
    true,
  );
  assert.equal(vp.hasProvenance({ dist: { attestations: { url: 'u' } } }), false);
  assert.equal(vp.hasProvenance({ dist: {} }), false);
  assert.equal(vp.hasProvenance(undefined), false);
});

test('solution tsconfig: bare tsc --noEmit checks zero files there, -b or -p walks the references', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-tsconfig-'));
  const write = (json) => fs.writeFileSync(path.join(dir, 'tsconfig.json'), json);
  // Vite's template shape, with the comments tsconfig files are allowed to carry.
  write('{\n  // solution\n  "files": [],\n  "references": [{ "path": "./tsconfig.app.json" }]\n}');
  assert.equal(policy.tsconfigIsSolution(dir), true);
  write('{"compilerOptions":{"strict":true},"include":["src"]}');
  assert.equal(policy.tsconfigIsSolution(dir), false);
  write(
    '{"compilerOptions":{"strict":true},"include":["src"],"references":[{"path":"./tsconfig.node.json"}]}',
  );
  assert.equal(
    policy.tsconfigIsSolution(dir),
    false,
    'own sources plus references is checked by bare tsc',
  );
  write('{"files":[]}');
  assert.equal(policy.tsconfigIsSolution(dir), false, 'no references means nothing to walk');
  write('not json');
  assert.equal(policy.tsconfigIsSolution(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });

  const walks = policy.typeCheckWalksReferences;
  assert.equal(walks('tsc --noEmit'), false);
  assert.equal(walks('tsc'), false);
  assert.equal(walks(''), false);
  assert.equal(walks('tsc -b --noEmit'), true);
  assert.equal(walks('tsc --build'), true);
  assert.equal(
    walks('tsc -p tsconfig.app.json --noEmit && tsc -p tsconfig.node.json --noEmit'),
    true,
  );
  assert.equal(walks('tsc --noEmit -p tsconfig.node.json'), true);
  assert.equal(walks('astro check'), true, 'a non-tsc checker is not judged here');
  assert.equal(walks('vue-tsc -b'), true);
});

test('coverage proofs: a gate that examined nothing is not a pass', () => {
  const zero = policy.zeroInputReason;
  assert.equal(zero('test:unit', 'ℹ tests 0\nℹ pass 0\nℹ fail 0'), 'the test runner found 0 tests');
  assert.equal(zero('test:integration', '# tests 0\n# pass 0'), 'the test runner found 0 tests');
  assert.equal(
    zero('test:unit', 'No test files found, exiting with code 1'),
    'the test runner found no test files',
  );
  assert.equal(zero('test:unit', 'ℹ tests 12\nℹ pass 12\nℹ fail 0'), null);
  assert.equal(zero('test:unit', '✓ 10 tests passed'), null, 'a count of 10 is not 0');
  assert.equal(zero('lint', 'ℹ tests 0'), null, 'only test gates are judged by test counts');

  const why = policy.emptyPassScriptReason;
  assert.match(why('echo "no tests yet"'), /stub/);
  assert.match(why('exit 0'), /stub/);
  assert.match(why('vitest run --passWithNoTests'), /passWithNoTests/);
  assert.match(why('stylelint "src/**/*.css" --allow-empty-input'), /allow-empty-input/);
  assert.match(why('eslint . --no-error-on-unmatched-pattern'), /unmatched-pattern/);
  assert.match(why('node --test tests/*.test.js || true'), /\|\| true/);
  assert.equal(why('vitest run src/utils --pool=threads'), null);
  assert.equal(why('node --test "shared/**/*.test.js"'), null);
  assert.equal(why(''), null);

  const covers = policy.eslintCoversTypeScript;
  assert.equal(covers({ devDependencies: { 'typescript-eslint': '^8' } }), true);
  assert.equal(covers({ devDependencies: { '@typescript-eslint/parser': '^8' } }), true);
  assert.equal(covers({ devDependencies: { eslint: '^9', 'eslint-plugin-astro': '^1' } }), false);
  assert.equal(covers({}), false);

  const pats = policy.nodeTestPatterns;
  assert.deepEqual(pats("node --test 'shared/**/*.test.js'"), ['shared/**/*.test.js']);
  assert.deepEqual(
    pats('node --test "packages/*/dist/test/**/*.test.js" "apps/*/dist/test/**/*.test.js"'),
    ['packages/*/dist/test/**/*.test.js', 'apps/*/dist/test/**/*.test.js'],
  );
  assert.deepEqual(pats('node --import ./tests/support/register.mjs --test tests/*.test.ts'), [
    'tests/*.test.ts',
  ]);
  assert.deepEqual(pats('node --test --test-reporter spec tests/a.test.js'), ['tests/a.test.js']);
  assert.deepEqual(pats('vitest run'), []);
  assert.deepEqual(pats('node tests/unit.js'), [], 'a custom runner names no --test patterns');
  assert.deepEqual(pats('npm run build && node --test dist/test/*.js'), ['dist/test/*.js']);
  assert.deepEqual(policy.TEST_GATE_SCRIPTS, [
    'test:unit',
    'test:smoke',
    'test:integration',
    'test:flows',
  ]);
});

test('treeScanGaps: eslint and vitest over the tree must ignore .claude/ (agent worktrees)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-treescan-'));
  const gaps = (scripts) => policy.treeScanGaps(dir, scripts);
  fs.writeFileSync(
    path.join(dir, 'eslint.config.js'),
    "export default [{ ignores: ['dist/**'] }];\n",
  );
  assert.equal(
    gaps({ lint: 'eslint . --max-warnings 0' }).length,
    1,
    'eslint . without the ignore',
  );
  assert.equal(gaps({ lint: 'eslint --max-warnings 0' }).length, 1, 'bare eslint defaults to .');
  assert.equal(
    gaps({ lint: 'eslint src server' }).length,
    0,
    'explicit paths never reach .claude/',
  );
  fs.writeFileSync(
    path.join(dir, 'eslint.config.js'),
    "export default [{ ignores: ['dist/**', '.claude/**'] }];\n",
  );
  assert.equal(gaps({ lint: 'eslint . --max-warnings 0' }).length, 0, 'ignored');
  assert.equal(
    gaps({ lint: 'eslint .', 'test:unit': 'vitest run' }).length,
    1,
    'vitest, no config',
  );
  assert.equal(
    gaps({ lint: 'eslint .', 'test:unit': 'vitest run src/utils --pool=threads' }).length,
    0,
  );
  fs.writeFileSync(
    path.join(dir, 'vite.config.ts'),
    "export default { test: { exclude: ['node_modules/**', '.claude/**'] } };\n",
  );
  assert.equal(gaps({ lint: 'eslint .', 'test:unit': 'vitest run' }).length, 0, 'vitest excluded');
  assert.equal(gaps({ lint: 'eslint .', 'test:unit': 'node --test tests/*.test.js' }).length, 0);
});

test('handlesByokKeys: matched on the provider call surface, not the word', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-byok-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(
    path.join(dir, 'server', 'settings.js'),
    "const providers = ['openai', 'anthropic'];\n",
  );
  assert.equal(policy.handlesByokKeys(dir), false, 'a dropdown is not a call');
  fs.writeFileSync(
    path.join(dir, 'server', 'ai.js'),
    "import Anthropic from '@anthropic-ai/sdk';\n",
  );
  assert.equal(policy.handlesByokKeys(dir), true);
  assert.match("fetch('https://api.openai.com/v1/chat')", policy.BYOK_CALL);
});

test('cmdScaffold --dry-run lists what it would add and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-scaffold-dry-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
  const before = fs.readdirSync(dir).sort();
  const plan = policy.cmdScaffold(dir, { dryRun: true, quiet: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'nothing written');
  assert.ok(plan.created.includes('.gitignore'));
  assert.ok(plan.created.some((c) => c.startsWith('package.json scripts:')));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.lint,
    undefined,
  );
});

test('ensureElectronBinary: absent module is null, a present binary is not re-downloaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-electron-'));
  assert.equal(policy.ensureElectronBinary(dir), null);
  const mod = path.join(dir, 'node_modules', 'electron');
  fs.mkdirSync(path.join(mod, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(mod, 'path.txt'), 'Electron\n');
  fs.writeFileSync(path.join(mod, 'dist', 'Electron'), '');
  assert.deepEqual(policy.ensureElectronBinary(dir), { present: true, downloaded: false });
});

test('site images: refs, prefix mapping, release status and the site audit', () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-site-'));
  const reg = {
    siteProject: path.basename(site),
    siteApps: {
      'app-one': { img: ['bp'] },
      'app-two': { repo: 'app-two-repo', img: ['ds'] },
    },
    siteSharedImages: ['membership'],
  };
  fs.mkdirSync(path.join(site, 'img', 'bp'), { recursive: true });
  fs.mkdirSync(path.join(site, 'img', 'membership'), { recursive: true });
  fs.mkdirSync(path.join(site, 'app-one'), { recursive: true });
  fs.mkdirSync(path.join(site, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(site, 'img', 'bp', 'hero.png'), '');
  fs.writeFileSync(path.join(site, 'img', 'bp', 'budget.png'), '');
  fs.writeFileSync(path.join(site, 'img', 'membership', 'plans.png'), '');
  fs.writeFileSync(path.join(site, 'package.json'), '{"name":"site"}');
  fs.writeFileSync(path.join(site, 'app-one', 'version.json'), '{"version":"2.1.0"}');
  fs.writeFileSync(
    path.join(site, 'index.html'),
    '<img src="/img/bp/hero.png"><img src="/img/membership/plans.png"><img src="/img/zz/x.png">',
  );
  fs.writeFileSync(path.join(site, 'app-one', 'index.html'), '<img src="/img/bp/budget.png">');
  fs.writeFileSync(path.join(site, 'dist', 'index.html'), '<img src="/img/bp/built.png">');

  const refs = policy.siteImageRefs(site);
  assert.deepEqual([...refs.keys()].sort(), [
    'img/bp/budget.png',
    'img/bp/hero.png',
    'img/membership/plans.png',
    'img/zz/x.png',
  ]);
  assert.deepEqual([...refs.get('img/bp/hero.png')], ['index.html'], 'dist is not scanned');
  assert.equal(policy.siteImageApp('img/bp/hero.png', reg), 'app-one');
  assert.equal(policy.siteImageApp('img/membership/plans.png', reg), null, 'shared');
  assert.equal(policy.siteImageApp('img/logo.png', reg), null, 'root-level');
  assert.equal(policy.siteImageApp('img/zz/x.png', reg), undefined, 'unclaimed prefix');

  // App side: no manifest yet.
  const app = path.join(path.dirname(site), 'app-one-' + path.basename(site));
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"app-one","version":"2.1.0"}');
  const regApp = {
    ...reg,
    siteApps: { 'app-one': { repo: path.basename(app), img: ['bp'] } },
  };
  let st = policy.siteImagesStatus(app, { registry: regApp, siteDir: site });
  assert.equal(st.manifestMissing, true);
  assert.equal(
    policy.siteImagesStatus(app, { registry: { ...reg, siteApps: {} }, siteDir: site }),
    null,
    'unmapped repo',
  );

  // Manifest: one image a minor behind, one current, one shared.
  fs.writeFileSync(
    path.join(site, 'img', 'screenshots.json'),
    JSON.stringify({
      images: {
        'img/bp/hero.png': {
          app: 'app-one',
          verifiedVersion: '2.0.3',
          lastVerified: '2026-09-01',
        },
        'img/bp/budget.png': {
          app: 'app-one',
          verifiedVersion: '2.1.0',
          lastVerified: '2026-10-01',
        },
        'img/membership/plans.png': {
          app: null,
          verifiedVersion: null,
          lastVerified: '2026-10-01',
        },
      },
    }),
  );
  st = policy.siteImagesStatus(app, { registry: regApp, siteDir: site });
  assert.equal(st.images.length, 2);
  assert.equal(st.pending.length, 1);
  assert.match(st.pending[0], /hero\.png.*2\.0\.3.*2\.1\.0/);
  assert.deepEqual(st.verified, ['2.0.3', '2.1.0']);
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"app-one","version":"2.1.4"}');
  assert.equal(
    policy.siteImagesStatus(app, { registry: regApp, siteDir: site }).pending.length,
    1,
    'patch bump changes nothing',
  );
});

test('site capture: generated shots compare exactly, hand-made ones by minor; the hook regex', () => {
  const b = policy.imageBehind;
  assert.equal(
    b({ captured: true, verifiedVersion: '1.5.0' }, '1.5.1'),
    true,
    'patch moves a captured shot',
  );
  assert.equal(b({ captured: true, verifiedVersion: '1.5.1' }, '1.5.1'), false);
  assert.equal(b({ verifiedVersion: '1.5.0' }, '1.5.9'), false, 'hand-made: patch is fine');
  assert.equal(b({ verifiedVersion: '1.5.0' }, '1.6.0'), true);
  assert.equal(b({ verifiedVersion: null }, '0.1.0'), true, 'unverified is behind');
  const re = policy.SITE_CAPTURE_INVOCATION;
  const run = (script) => ['npm', 'run', script].join(' ');
  assert.ok(re.test(run('site:capture')));
  assert.ok(re.test(['npm', '--prefix', '../some-app', 'run', 'site:capture'].join(' ')));
  assert.ok(!re.test('grep site:capture package.json'));
  assert.ok(!re.test(run('docs:' + 'capture')));
});

test('siteCaptureWindow: registry value with a 1512x1045 default', () => {
  assert.deepEqual(policy.siteCaptureWindow({}), { width: 1512, height: 1045 });
  assert.deepEqual(
    policy.siteCaptureWindow({ siteCaptureWindow: { width: '1600', height: 1000 } }),
    { width: 1600, height: 1000 },
  );
});

test('behindWanted: only a newer wanted counts; a current ahead of latest is not stale', () => {
  const b = policy.behindWanted;
  assert.equal(b('26.15.0', '26.15.3'), true);
  assert.equal(b('26.15.3', '26.15.3'), false);
  assert.equal(b('26.17.0', '26.15.3'), false, 'installed from a newer dist-tag');
  assert.equal(b('25.9.0', '26.15.3'), false, 'major: not this rule');
  assert.equal(b('', '1.0.0'), false);
  assert.equal(
    policy.staleRecordIsDowngrade('electron-builder 26.17.0 -> 26.15.3 (128d old)'),
    true,
  );
  assert.equal(policy.staleRecordIsDowngrade('left-pad 1.2.0 -> 1.3.0 (40d old)'), false);
  assert.equal(policy.staleRecordIsDowngrade('garbage'), false);
});

test('policy reports: append numbers entries, list parses them, close marks one', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-reports-')), 'REPORTS.md');
  assert.equal(
    policy.appendReport(file, {
      project: 'app-one',
      version: '2.80',
      text: 'scaffold adds x\nsecond line',
    }),
    'R-1',
  );
  assert.equal(
    policy.appendReport(file, {
      project: 'app-two',
      version: '2.80',
      text: 'gate y passes on empty',
    }),
    'R-2',
  );
  let rs = policy.parseReports(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(
    rs.map((r) => [r.id, r.project, r.status]),
    [
      ['R-1', 'app-one', 'open'],
      ['R-2', 'app-two', 'open'],
    ],
  );
  assert.equal(rs[0].body, 'scaffold adds x\nsecond line');
  assert.equal(policy.closeReport(file, 'R-1', 'fixed in 2.81'), true);
  assert.equal(policy.closeReport(file, 'R-1', 'again'), false, 'already closed');
  assert.equal(policy.closeReport(file, 'R-9', 'nope'), false);
  rs = policy.parseReports(fs.readFileSync(file, 'utf8'));
  assert.equal(rs[0].status, 'closed');
  assert.match(rs[0].closed, /fixed in 2.81/);
  assert.equal(rs[1].status, 'open');
  assert.equal(
    policy.appendReport(file, { project: 'app-one', version: '2.80', text: 'z' }),
    'R-3',
    'numbering continues past closed',
  );
});

test('siteTrackedImages: a store image under an app folder is tracked without a page (R-1)', () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-store-'));
  const reg = { siteApps: { 'app-one': { img: ['ao'] } }, siteSharedImages: ['membership'] };
  fs.mkdirSync(path.join(site, 'img', 'ao'), { recursive: true });
  fs.mkdirSync(path.join(site, 'img', 'zz'), { recursive: true });
  fs.writeFileSync(path.join(site, 'img', 'ao', 'hero.png'), '');
  fs.writeFileSync(path.join(site, 'img', 'ao', 'store-cover.png'), '');
  fs.writeFileSync(path.join(site, 'img', 'ao', 'notes.txt'), '');
  fs.writeFileSync(path.join(site, 'img', 'zz', 'x.png'), '');
  fs.writeFileSync(path.join(site, 'index.html'), '<img src="/img/ao/hero.png">');
  const t = policy.siteTrackedImages(site, reg);
  assert.deepEqual([...t.keys()].sort(), ['img/ao/hero.png', 'img/ao/store-cover.png']);
  assert.deepEqual([...t.get('img/ao/hero.png')], ['index.html']);
  assert.equal(t.get('img/ao/store-cover.png').size, 0, 'store image: no page');
});

test('playwrightRemoteTarget: a deployed default base URL without webServer is a gap', () => {
  const p = policy.playwrightRemoteTarget;
  assert.equal(p("use: { baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://example.com', }"), 'https://example.com');
  assert.equal(p("use: { baseURL: 'https://example.com/app' }"), 'https://example.com/app');
  assert.equal(p("use: { baseURL: process.env.BASE || 'http://localhost:8080' }"), null, 'local fallback');
  assert.equal(p("use: { baseURL: 'http://127.0.0.1:3000' }"), null);
  assert.equal(p("webServer: { command: 'npm run preview', url: 'http://localhost:8080' },\nuse: { baseURL: process.env.X || 'https://example.com' }"), null, 'webServer serves the tree');
  assert.equal(p("use: { baseURL: process.env.PLAYWRIGHT_BASE_URL }"), null, 'env only');
  assert.equal(p("export default defineConfig({ testDir: './tests' })"), null, 'Electron flows: no base URL');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-pw-'));
  assert.equal(policy.playwrightTargetGap(dir), null);
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), "export default { use: { baseURL: 'https://example.com' } }");
  assert.deepEqual(policy.playwrightTargetGap(dir), { file: 'playwright.config.ts', url: 'https://example.com' });
});
