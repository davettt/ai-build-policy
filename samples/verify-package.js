#!/usr/bin/env node

// Sample from the guidebook (MIT licence). It shows how I look at an npm package (registry
// facts plus one Socket score) before it goes on the allowlist; read it and adapt it to your
// project rather than copying it as is. See guide 4.2.

/**
 * Verify an npm package before adding it to the allowlist.
 * Queries the npm registry for metadata and the Socket CLI for one package
 * score, flags risks, and prints the allowlist entry with the score recorded.
 *
 * Usage: node verify-package.js <package-name>[@<version>]
 *
 * With a version, the deprecation, provenance and Socket checks judge that
 * version, the one about to be installed, instead of latest.
 *
 * If Socket cannot be reached, the package waits: no score is recorded, the
 * script exits non-zero, and the allowlist check refuses an entry without one.
 */

const https = require('https');
const { execFileSync } = require('child_process');

/** Split "name@version" (scoped or not) into its parts. */
function parseSpec(spec) {
  const s = String(spec || '');
  const at = s.lastIndexOf('@');
  if (at > 0) return { name: s.slice(0, at), version: s.slice(at + 1) || null };
  return { name: s, version: null };
}

const spec = parseSpec(process.argv[2]);
const pkg = spec.name;

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

let flags = 0;
const flag = (msg) => {
  flags++;
  console.log(`  ${RED}FLAG${RESET}  ${msg}`);
};
const warn = (msg) => console.log(`  ${YELLOW}WARN${RESET}  ${msg}`);
const pass = (msg) => console.log(`  ${GREEN}OK${RESET}    ${msg}`);
const today = () => new Date().toISOString().split('T')[0];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 404) return resolve(null);
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Failed to parse response from ${url}`));
          }
        });
      })
      .on('error', reject);
  });
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

/** npm provenance: the version was published from CI with a signed build attestation. */
function hasProvenance(versionDoc) {
  const att = versionDoc && versionDoc.dist && versionDoc.dist.attestations;
  return !!(att && att.provenance);
}

/** One Socket score for the package and its dependencies, retrying on a rate limit. */
async function socketScore(name, version) {
  const scoreOnce = () => {
    const out = execFileSync('socket', ['package', 'score', 'npm', `${name}@${version}`, '--json'], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out.slice(out.indexOf('{')));
    if (parsed.ok === false) throw Object.assign(new Error(JSON.stringify(parsed)), { stdout: out });
    return parsed;
  };
  // Socket rate-limits after a handful of calls, so back off on a 429 and
  // retry; scoring a whole allowlist in a loop then paces itself.
  for (const wait of [15, 30, 60, 0]) {
    try {
      return scoreOnce();
    } catch (err) {
      const msg = `${(err && err.stdout) || ''} ${(err && err.stderr) || ''} ${(err && err.message) || ''}`;
      if (!/429/.test(msg) || wait === 0) throw err;
      console.log(`  ${DIM}Socket rate limited — retrying in ${wait}s${RESET}`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

async function main() {
  console.log(`\n${BOLD}Package verification: ${pkg}${RESET}\n`);

  const [registry, downloads] = await Promise.all([
    fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`),
    fetchJson(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`),
  ]);
  if (!registry) {
    console.log(`  ${RED}FLAG${RESET}  Package "${pkg}" not found on npm registry`);
    process.exit(1);
  }

  const versions = Object.keys(registry.versions || {}).length;
  const latest = (registry['dist-tags'] || {}).latest || 'unknown';
  if (spec.version && !(registry.versions && Object.hasOwn(registry.versions, spec.version))) {
    console.log(`  ${RED}FLAG${RESET}  ${pkg}@${spec.version} is not a published version (latest is ${latest})`);
    process.exit(1);
  }
  // The version being judged: the one asked for, or latest.
  const target = spec.version || latest;
  const versionDoc = registry.versions && registry.versions[target];
  const description = registry.description || '(none)';
  const repoUrl =
    typeof registry.repository === 'string' ? registry.repository : (registry.repository || {}).url || '(none)';
  const maintainerNames = (registry.maintainers || []).map((m) => m.name);
  const weeklyDownloads = (downloads && downloads.downloads) || 0;
  const published = (registry.time || {})[latest] || null;
  const deprecated = (versionDoc && versionDoc.deprecated) || null;

  console.log(`  Name:        ${registry.name}`);
  console.log(`  Description: ${description}`);
  console.log(`  Latest:      ${latest}${target !== latest ? `  (checking ${target})` : ''}`);
  console.log(`  Versions:    ${versions}`);
  console.log(`  Downloads:   ${weeklyDownloads.toLocaleString()}/week`);
  console.log(`  Repository:  ${repoUrl}`);
  console.log(`  Maintainers: ${maintainerNames.join(', ') || '(none)'}`);
  if (published) console.log(`  Published:   ${published.split('T')[0]} (${daysSince(published)} days ago)`);
  if (deprecated) console.log(`  ${RED}Deprecated:  ${deprecated}${RESET}`);
  console.log();

  // A name-squat has few versions and almost no downloads.
  if (versions <= 1) flag(`Only ${versions} version published — high risk of name-squatting`);
  else if (versions <= 3) warn(`Only ${versions} versions published — verify this is actively maintained`);
  else pass(`${versions} versions published`);

  if (weeklyDownloads < 100) flag(`${weeklyDownloads} weekly downloads — extremely low, likely not a real package`);
  else if (weeklyDownloads < 1000) warn(`${weeklyDownloads} weekly downloads — low, verify legitimacy`);
  else if (weeklyDownloads < 10000) warn(`${weeklyDownloads} weekly downloads — moderate`);
  else pass(`${weeklyDownloads.toLocaleString()} weekly downloads`);

  if (repoUrl === '(none)') flag('No repository URL — cannot verify upstream source');
  else pass(`Repository: ${repoUrl}`);

  const provenance = hasProvenance(versionDoc);
  if (provenance) pass(`Provenance attestation on ${target}`);
  else warn("No provenance attestation — the publish cannot be tied to the repository's CI");

  if (!registry.description || registry.description.startsWith('>')) flag(`Suspicious or missing description: "${description}"`);

  if (maintainerNames.length <= 1) warn('Single maintainer — verify they are the legitimate author');
  else pass(`${maintainerNames.length} maintainers`);

  // Maintenance lifecycle
  console.log(`\n  ${BOLD}Maintenance lifecycle:${RESET}`);
  if (deprecated) flag(`Package is deprecated: ${deprecated}`);
  const days = daysSince(published);
  let maintenance = deprecated ? 'deprecated' : 'maintained';
  if (days === null) warn('Could not determine last publish date');
  else if (days > 730) flag(`Last published ${days} days ago (over 2 years) — likely unmaintained`);
  else if (days > 540) warn(`Last published ${days} days ago (over 18 months) — dormant, security patches unlikely`);
  else if (days > 365) warn(`Last published ${days} days ago (over 1 year) — monitor for maintenance`);
  else pass(`Last published ${days} days ago`);
  if (!deprecated && days > 540) maintenance = 'dormant';
  console.log(`  ${DIM}Assessment: ${maintenance}${RESET}`);

  // Socket: one score for this package and its dependencies.
  console.log(`\n  ${BOLD}Socket risk assessment:${RESET}`);
  let socket = { checked: null, status: 'unavailable' };
  try {
    const data = (await socketScore(pkg, target)).data || {};
    const self = (data.self && data.self.score) || {};
    const deep = (data.transitively && data.transitively.score) || {};
    const alerts = [...((data.self && data.self.alerts) || []), ...((data.transitively && data.transitively.alerts) || [])];
    const serious = alerts.filter((a) => /critical|high/i.test(String(a.severity || a.severityName || '')));
    socket = {
      checked: today(),
      status: 'scored',
      version: target,
      supplyChain: self.supplyChain,
      vulnerability: self.vulnerability,
      deepSupplyChain: deep.supplyChain,
      deepVulnerability: deep.vulnerability,
      alerts: serious
        .map((a) => {
          const pr = a.props || {};
          return [a.type || a.name || 'alert', pr.cveId || pr.ghsaId || pr.title, a.purl || a.package || pr.purl]
            .filter(Boolean)
            .join(' ');
        })
        .slice(0, 10),
    };
    // Judge the package's own scores and its specific alerts. The
    // with-dependencies score is an aggregate over everything it pulls in:
    // anything built on a big framework lands low, so flagging it fires on
    // every ordinary package. It is recorded, so a later re-score shows a drop.
    const before = flags;
    for (const [label, v] of [['supply-chain', self.supplyChain], ['vulnerability', self.vulnerability]]) {
      if (typeof v !== 'number') flag(`Socket returned no ${label} score for the package itself`);
      else if (v < 90) flag(`Socket ${label} score ${v} for the package itself — below 90`);
      else pass(`Socket ${label} score ${v} for the package itself`);
    }
    if (serious.length) flag(`Socket critical/high alerts in the package or its dependencies: ${socket.alerts.join(', ')}`);
    console.log(`  ${DIM}With dependencies (recorded, not judged): supply chain ${deep.supplyChain}, vulnerability ${deep.vulnerability}${RESET}`);
    socket.flagged = flags > before;
  } catch (err) {
    const msg = `${(err && err.stdout) || ''} ${(err && err.stderr) || ''} ${(err && err.message) || ''}`;
    flag(
      `No Socket score (${/429/.test(msg) ? 'rate limited' : 'socket CLI unavailable or failed'}). ` +
        'The package waits: it is not approvable until a score is recorded.',
    );
  }

  // Summary and the entry to paste into the allowlist
  console.log();
  if (flags > 0) {
    console.log(`${RED}${BOLD}RESULT: ${flags} flag(s) raised — do NOT add to the allowlist without manual verification${RESET}`);
    console.log('Review the flags above. If this is a known false positive, document why.\n');
    if (maintenance !== 'maintained') console.log(`${YELLOW}This package appears ${maintenance}. Look for successors or forks first.${RESET}\n`);
  } else {
    console.log(`${GREEN}${BOLD}RESULT: No flags raised — safe to add to the allowlist after a read-through${RESET}\n`);
  }

  console.log('Suggested allowlist entry:');
  const entry = {
    repo: repoUrl === '(none)' ? 'UNKNOWN' : repoUrl.replace(/^git\+/, '').replace(/\.git$/, ''),
    publisher: maintainerNames[0] || 'unknown',
    weeklyDownloads,
    versions,
    verified: today(),
    lastPublished: published ? published.split('T')[0] : null,
    provenance,
    maintenance,
    successor: deprecated || null,
    socket,
    notes: '',
  };
  console.log(JSON.stringify({ [pkg]: entry }, null, 2));
  console.log();
  if (socket.flagged) {
    console.log(
      `${YELLOW}Socket raised a flag. If the package is accepted anyway, record why in the entry, or the allowlist check refuses it:\n` +
        `  "socket": { ..., "decision": { "verdict": "accepted", "reason": "<why>", "date": "${today()}" } }${RESET}\n`,
    );
  }
  if (flags > 0) process.exit(1);
}

module.exports = { parseSpec, hasProvenance };

if (require.main === module) {
  if (!pkg) {
    console.error('Usage: node verify-package.js <package-name>[@<version>]');
    process.exit(1);
  }
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
