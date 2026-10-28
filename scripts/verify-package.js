#!/usr/bin/env node

/**
 * Verify an npm package before adding it to the allowlist.
 * Queries the npm registry for metadata and Socket for one package score,
 * flags risks, and prints the allowlist entry with the score recorded.
 * Includes maintenance lifecycle assessment.
 *
 * Usage: node verify-package.js <package-name>[@<version>]
 *
 * With a version, the deprecation, provenance and Socket checks judge that
 * version, the one about to be installed, instead of latest. The name alone
 * still judges latest.
 */

const https = require('https');
const { execFileSync } = require('child_process');

/**
 * Split "name@version" (scoped or not) into its parts. The registry is asked
 * for the name; the whole string used to be encoded into the URL, so
 * "electron@44.10.0" came back "not found on npm registry" (R-40, R-41).
 */
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

function flag(msg) {
  console.log(`  ${RED}FLAG${RESET}  ${msg}`);
}
function warn(msg) {
  console.log(`  ${YELLOW}WARN${RESET}  ${msg}`);
}
function pass(msg) {
  console.log(`  ${GREEN}OK${RESET}    ${msg}`);
}

function fetch(url) {
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

/** owner/repo from a GitHub repository URL in any of npm's spellings, or null. */
function parseGithubRepo(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com[/:]([^/]+)\/([^/#?]+)/);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, '');
  // Both land in a URL path; the registry doc that supplies them is written by
  // the package's publisher, so only GitHub's own name alphabet is accepted.
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || owner === '..' || repo === '..')
    return null;
  return { owner, repo };
}

/**
 * A monorepo `repository.directory` safe to put in a raw.githubusercontent.com
 * path: plain path segments only, no `..`, so a publisher cannot steer the
 * package.json read to another repository and pass the name check.
 */
function safeDirectory(directory) {
  if (typeof directory !== 'string') return null;
  const clean = directory.replace(/^\/+|\/+$/g, '');
  if (!clean) return null;
  const segments = clean.split('/');
  if (!segments.every((seg) => /^[A-Za-z0-9_.@-]+$/.test(seg) && seg !== '.' && seg !== '..')) return null;
  return clean;
}

/**
 * Does the linked repository publish this package? A name-squat can set its
 * `repository` field to the genuine upstream's GitHub, so the repo looks
 * right, is active and has stars, while publishing something else. The repo's
 * own package.json (at the root, or at `repository.directory` in a monorepo)
 * has to carry the npm name.
 *   match     — a package.json in the repo names this package
 *   mismatch  — the package.json found names a different package (the squat case,
 *               unless the two packages share an npm maintainer: then 'sibling')
 *   monorepo  — the root is a workspace root and no directory was given, so unconfirmed
 *   unknown   — nothing readable (not GitHub, no package.json, network)
 */
function repoNameMatch(pkg, rootPkg, dirPkg) {
  const names = [dirPkg && dirPkg.name, rootPkg && rootPkg.name].filter(Boolean);
  if (names.includes(pkg)) return 'match';
  if (dirPkg && dirPkg.name) return 'mismatch';
  if (rootPkg && rootPkg.workspaces) return 'monorepo';
  if (rootPkg && rootPkg.name) return 'mismatch';
  return 'unknown';
}

/**
 * Do two npm packages share a maintainer? A squat cannot be maintained by the
 * genuine package's maintainers, so a shared maintainer between the package
 * under review and the one its repo really publishes (lodash-es and lodash)
 * means the same publisher, not a squat.
 */
function sharesMaintainer(a, b) {
  const names = (doc) => new Set(((doc && doc.maintainers) || []).map((m) => m && m.name).filter(Boolean));
  const left = names(a);
  for (const n of names(b)) if (left.has(n)) return true;
  return false;
}

/** npm provenance: the version was published from CI with a signed build attestation. */
function hasProvenance(versionDoc) {
  const att = versionDoc && versionDoc.dist && versionDoc.dist.attestations;
  return !!(att && att.provenance);
}

async function fetchRepoPackageJson(owner, repo, directory) {
  const sub = directory ? `${directory}/` : '';
  try {
    return await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${sub}package.json`);
  } catch {
    return null;
  }
}

function assessMaintenance(lastPublished, deprecated, repoArchived) {
  if (deprecated) return 'deprecated';
  if (repoArchived) return 'deprecated';
  const days = daysSince(lastPublished);
  if (days === null) return 'maintained';
  if (days > 540) return 'dormant';
  return 'maintained';
}

async function checkRepoArchived(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  const [, owner, repo] = match;
  const cleanRepo = repo.replace(/\.git$/, '');
  try {
    const data = await new Promise((resolve, reject) => {
      https
        .get(
          `https://api.github.com/repos/${owner}/${cleanRepo}`,
          { headers: { 'User-Agent': 'verify-package/1.0' } },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
              try {
                resolve(JSON.parse(body));
              } catch {
                resolve(null);
              }
            });
          },
        )
        .on('error', () => resolve(null));
    });
    if (data && typeof data.archived === 'boolean') return data.archived;
  } catch {
    // GitHub API unavailable
  }
  return null;
}

async function main() {
  console.log(`\n${BOLD}Package verification: ${pkg}${RESET}\n`);

  const [registry, downloads] = await Promise.all([
    fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`),
    fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`),
  ]);

  if (!registry) {
    flag(`Package "${pkg}" not found on npm registry`);
    process.exit(1);
  }

  let flags = 0;

  // Basic info
  const versions = Object.keys(registry.versions || {}).length;
  const latest = registry['dist-tags']?.latest || 'unknown';
  // The version being judged: the one asked for, or latest.
  if (spec.version && !(registry.versions && Object.hasOwn(registry.versions, spec.version))) {
    flag(`${pkg}@${spec.version} is not a published version (latest is ${latest})`);
    process.exit(1);
  }
  const target = spec.version || latest;
  const description = registry.description || '(none)';
  const repoUrl =
    typeof registry.repository === 'string'
      ? registry.repository
      : registry.repository?.url || '(none)';
  const maintainers = (registry.maintainers || []).map((m) => m.name).join(', ') || '(none)';
  const weeklyDownloads = downloads?.downloads || 0;

  // Maintenance lifecycle data
  const timeData = registry.time || {};
  const latestPublishDate = latest !== 'unknown' && timeData[latest] ? timeData[latest] : null;
  const deprecated =
    registry.versions && target !== 'unknown' && registry.versions[target]
      ? registry.versions[target].deprecated || null
      : null;

  console.log(`  Name:        ${registry.name}`);
  console.log(`  Description: ${description}`);
  console.log(`  Latest:      ${latest}`);
  if (target !== latest) {
    const at = timeData[target] ? ` (published ${timeData[target].split('T')[0]})` : '';
    console.log(`  Checking:    ${target}${at}`);
  }
  console.log(`  Versions:    ${versions}`);
  console.log(`  Downloads:   ${weeklyDownloads.toLocaleString()}/week`);
  console.log(`  Repository:  ${repoUrl}`);
  console.log(`  Maintainers: ${maintainers}`);
  if (latestPublishDate) {
    const days = daysSince(latestPublishDate);
    console.log(
      `  Published:   ${latestPublishDate.split('T')[0]} (${days} days ago)`,
    );
  }
  if (deprecated) {
    console.log(`  ${RED}Deprecated:  ${deprecated}${RESET}`);
  }
  console.log();

  // Version count check
  if (versions <= 1) {
    flag(`Only ${versions} version published — high risk of name-squatting`);
    flags++;
  } else if (versions <= 3) {
    warn(`Only ${versions} versions published — verify this is actively maintained`);
  } else {
    pass(`${versions} versions published`);
  }

  // Download count check
  if (weeklyDownloads < 100) {
    flag(`${weeklyDownloads} weekly downloads — extremely low, likely not a real package`);
    flags++;
  } else if (weeklyDownloads < 1000) {
    warn(`${weeklyDownloads} weekly downloads — low, verify legitimacy`);
  } else if (weeklyDownloads < 10000) {
    warn(`${weeklyDownloads} weekly downloads — moderate`);
  } else {
    pass(`${weeklyDownloads.toLocaleString()} weekly downloads`);
  }

  // Repository check: the URL exists, and the repo actually publishes this name
  let repoMatch = 'unknown';
  let foundName = null;
  if (repoUrl === '(none)') {
    flag('No repository URL — cannot verify upstream source');
    flags++;
  } else {
    pass(`Repository: ${repoUrl}`);
    const gh = parseGithubRepo(repoUrl);
    const directory = safeDirectory(registry.repository && registry.repository.directory);
    if (gh) {
      const [rootPkg, dirPkg] = await Promise.all([
        fetchRepoPackageJson(gh.owner, gh.repo),
        directory ? fetchRepoPackageJson(gh.owner, gh.repo, directory) : null,
      ]);
      repoMatch = repoNameMatch(pkg, rootPkg, dirPkg);
      foundName = (dirPkg && dirPkg.name) || (rootPkg && rootPkg.name) || null;
    }
    if (repoMatch === 'match') {
      pass(`Repository publishes "${pkg}"${directory ? ` from ${directory}` : ''}`);
    } else if (repoMatch === 'mismatch') {
      let sibling = null;
      try {
        sibling = foundName ? await fetch(`https://registry.npmjs.org/${encodeURIComponent(foundName)}`) : null;
      } catch {
        sibling = null;
      }
      if (sharesMaintainer(registry, sibling)) {
        repoMatch = 'sibling';
        warn(`Repository publishes "${foundName}", not "${pkg}", but both share an npm maintainer — a variant build of the same project`);
      } else {
        flag(
          `Repository does not publish "${pkg}" (its package.json is named "${foundName || '?'}") — ` +
            'a name-squat points at a real project\'s repo; confirm the upstream by hand',
        );
        flags++;
      }
    } else if (repoMatch === 'monorepo') {
      warn('Repository is a workspace root and npm gives no directory — confirm the package lives in it');
    } else {
      warn(gh ? 'Could not read the repository\'s package.json — confirm it publishes this package' : 'Repository is not on GitHub — confirm it publishes this package by hand');
    }
  }

  // Provenance: published from CI with a signed attestation (npm --provenance)
  const provenance = hasProvenance(registry.versions && registry.versions[target]);
  if (provenance) pass(`Provenance attestation on ${target === latest ? 'the latest version' : target}`);
  else warn('No provenance attestation — the publish cannot be tied to the repository\'s CI');

  // Description check
  if (!description || description === '(none)' || description.startsWith('>')) {
    flag(`Suspicious or missing description: "${description}"`);
    flags++;
  }

  // Maintainer count
  const maintainerCount = (registry.maintainers || []).length;
  if (maintainerCount <= 1) {
    warn(`Single maintainer — verify they are the legitimate author`);
  } else {
    pass(`${maintainerCount} maintainers`);
  }

  // Maintenance lifecycle checks
  console.log(`\n  ${BOLD}Maintenance lifecycle:${RESET}`);

  if (deprecated) {
    flag(`Package is deprecated: ${deprecated}`);
    flags++;
  }

  let repoArchived = null;
  if (repoUrl !== '(none)' && repoUrl.includes('github.com')) {
    repoArchived = await checkRepoArchived(repoUrl);
    if (repoArchived === true) {
      flag('Repository is archived (read-only)');
      flags++;
    } else if (repoArchived === false) {
      pass('Repository is not archived');
    } else {
      warn('Could not check repository archive status (GitHub API)');
    }
  }

  if (latestPublishDate) {
    const days = daysSince(latestPublishDate);
    if (days > 730) {
      flag(`Last published ${days} days ago (over 2 years) — likely unmaintained`);
      flags++;
    } else if (days > 540) {
      warn(`Last published ${days} days ago (over 18 months) — dormant, security patches unlikely`);
    } else if (days > 365) {
      warn(`Last published ${days} days ago (over 1 year) — monitor for maintenance`);
    } else {
      pass(`Last published ${days} days ago`);
    }
  } else {
    warn('Could not determine last publish date');
  }

  const maintenance = assessMaintenance(
    latestPublishDate,
    !!deprecated,
    repoArchived === true,
  );
  console.log(`  ${DIM}Assessment: ${maintenance}${RESET}`);

  // Socket risk assessment: one score for this package and its dependencies.
  // Installs no longer go through the Socket wrapper (policy 2.58); a new
  // package is the moment that warrants a closer look, so its score is taken
  // here and recorded in the allowlist entry, which deps:check requires.
  console.log(`\n  ${BOLD}Socket risk assessment:${RESET}`);
  let socket = { checked: null, status: 'unavailable' };
  try {
    const scoreOnce = () => {
      const out = execFileSync('socket', ['package', 'score', 'npm', `${pkg}@${target}`, '--json'], {
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(out.slice(out.indexOf('{')));
      if (parsed.ok === false) throw Object.assign(new Error(JSON.stringify(parsed)), { stdout: out });
      return parsed;
    };
    // Socket rate-limits after a handful of calls, so scoring a whole
    // allowlist recorded every later package as 'unavailable' (R-2,
    // 2026-10-17). Back off on a 429 and retry; a loop then paces itself.
    let parsed;
    for (const wait of [15, 30, 60, 0]) {
      try {
        parsed = scoreOnce();
        break;
      } catch (err) {
        const msg = `${(err && err.stdout) || ''} ${(err && err.stderr) || ''} ${(err && err.message) || ''}`;
        if (!/429/.test(msg) || wait === 0) throw err;
        console.log(`  ${DIM}Socket rate limited — retrying in ${wait}s${RESET}`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
    const data = parsed.data || {};
    const self = (data.self && data.self.score) || {};
    const deep = (data.transitively && data.transitively.score) || {};
    const alerts = [...((data.self && data.self.alerts) || []), ...((data.transitively && data.transitively.alerts) || [])];
    const serious = alerts.filter((a) => /critical|high/i.test(String(a.severity || a.severityName || '')));
    socket = {
      checked: new Date().toISOString().split('T')[0],
      status: 'scored',
      version: target,
      supplyChain: self.supplyChain,
      vulnerability: self.vulnerability,
      deepSupplyChain: deep.supplyChain,
      deepVulnerability: deep.vulnerability,
      // Type plus whatever identifies it (CVE/GHSA id or title, affected package)
      alerts: serious
        .map((a) => {
          const pr = a.props || {};
          return [a.type || a.name || 'alert', pr.cveId || pr.ghsaId || pr.title, a.purl || a.package || pr.purl]
            .filter(Boolean)
            .join(' ');
        })
        .slice(0, 10),
    };
    // Judge the package's own scores and specific alerts. The with-dependencies
    // score is an aggregate over everything it pulls in: anything built on
    // React and a build tool lands around 50-70, so flagging it fired on every
    // ordinary framework and taught sessions to argue past the flag. It is
    // recorded, so a later re-score shows whether it dropped.
    const low = (v) => typeof v === 'number' && v < 90;
    const before = flags;
    // flag() only prints; this script counts flags itself.
    if (low(self.supplyChain)) {
      flag(`Socket supply-chain score ${self.supplyChain} for the package itself — below 90`);
      flags++;
    }
    else pass(`Socket supply-chain score ${self.supplyChain} for the package itself`);
    if (low(self.vulnerability)) {
      flag(`Socket vulnerability score ${self.vulnerability} for the package itself — below 90`);
      flags++;
    } else pass(`Socket vulnerability score ${self.vulnerability} for the package itself`);
    if (serious.length) {
      flag(`Socket critical/high alerts in the package or its dependencies: ${socket.alerts.join(', ')}`);
      flags++;
    }
    console.log(
      `  ${DIM}With dependencies (recorded, not judged): supply chain ${deep.supplyChain}, vulnerability ${deep.vulnerability}${RESET}`,
    );
    socket.flagged = flags > before;
  } catch (err) {
    const msg = `${(err && err.stdout) || ''} ${(err && err.stderr) || ''} ${(err && err.message) || ''}`;
    flag(
      `No Socket score (${/429/.test(msg) ? 'rate limited — check socket organization quota and retry' : 'socket CLI unavailable or failed'}). ` +
        `The package is not approvable until a score is recorded, or the developer records a waiver in the allowlist entry.`,
    );
    flags++;
  }

  // Summary
  console.log();
  const cleanRepo = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
  const lastPubDate = latestPublishDate ? latestPublishDate.split('T')[0] : null;

  if (flags > 0) {
    console.log(
      `${RED}${BOLD}RESULT: ${flags} flag(s) raised — do NOT add to allowlist without manual verification${RESET}`,
    );
    console.log('Review the flags above. If this is a known false positive, document why.\n');
    if (maintenance === 'deprecated' || maintenance === 'dormant') {
      console.log(
        `${YELLOW}This package appears ${maintenance}. Investigate successors or forks before adding.${RESET}\n`,
      );
    }
  } else {
    console.log(
      `${GREEN}${BOLD}RESULT: No flags raised — safe to add to allowlist after agent review${RESET}\n`,
    );
  }

  console.log('Suggested allowlist entry:');
  const entry = {
    repo: cleanRepo !== '(none)' ? cleanRepo : 'UNKNOWN',
    publisher: maintainers.split(', ')[0],
    weeklyDownloads,
    versions,
    verified: new Date().toISOString().split('T')[0],
    lastPublished: lastPubDate,
    repoArchived: repoArchived !== null ? repoArchived : false,
    repoMatch,
    provenance,
    maintenance,
    successor: deprecated || null,
    socket,
    notes: '',
  };
  console.log(JSON.stringify({ [pkg]: entry }, null, 2));
  console.log();

  if (socket.flagged)
    console.log(
      `${YELLOW}Socket raised a flag. If the package is accepted anyway, record why in the entry, or deps:check refuses it:\n` +
        `  "socket": { ..., "decision": { "verdict": "accepted", "reason": "<why>", "date": "${new Date().toISOString().split('T')[0]}" } }${RESET}\n`,
    );
  if (flags > 0) process.exit(1);
}

module.exports = { parseSpec, parseGithubRepo, repoNameMatch, hasProvenance, sharesMaintainer, safeDirectory };

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
