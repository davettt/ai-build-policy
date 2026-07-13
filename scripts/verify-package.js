#!/usr/bin/env node

/**
 * Verify an npm package before adding it to the allowlist.
 * Queries npm registry and Socket CLI for metadata, flags risks.
 *
 * Usage: node verify-package.js <package-name>
 */

const https = require('https');
const { execFileSync } = require('child_process');

const pkg = process.argv[2];
if (!pkg) {
  console.error('Usage: node verify-package.js <package-name>');
  process.exit(1);
}

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

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
  const description = registry.description || '(none)';
  const repoUrl =
    typeof registry.repository === 'string'
      ? registry.repository
      : registry.repository?.url || '(none)';
  const maintainers = (registry.maintainers || []).map((m) => m.name).join(', ') || '(none)';
  const weeklyDownloads = downloads?.downloads || 0;

  console.log(`  Name:        ${registry.name}`);
  console.log(`  Description: ${description}`);
  console.log(`  Latest:      ${latest}`);
  console.log(`  Versions:    ${versions}`);
  console.log(`  Downloads:   ${weeklyDownloads.toLocaleString()}/week`);
  console.log(`  Repository:  ${repoUrl}`);
  console.log(`  Maintainers: ${maintainers}`);
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

  // Repository check
  if (repoUrl === '(none)') {
    flag('No repository URL — cannot verify upstream source');
    flags++;
  } else {
    pass(`Repository: ${repoUrl}`);
  }

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

  // Socket CLI check
  console.log();
  try {
    const socketOutput = execFileSync('socket', ['npm', 'info', pkg], {
      encoding: 'utf8',
      timeout: 15000,
    });
    const socketLines = socketOutput.split('\n').filter((l) => l.trim());
    console.log(`  ${BOLD}Socket CLI output:${RESET}`);
    for (const line of socketLines.slice(0, 20)) {
      console.log(`  ${line}`);
    }
  } catch {
    warn('Socket CLI not available or query failed — manual review required');
  }

  // Summary
  console.log();
  if (flags > 0) {
    console.log(
      `${RED}${BOLD}RESULT: ${flags} flag(s) raised — do NOT add to allowlist without manual verification${RESET}`,
    );
    console.log('Review the flags above. If this is a known false positive, document why.\n');
    process.exit(1);
  } else {
    console.log(
      `${GREEN}${BOLD}RESULT: No flags raised — safe to add to allowlist after agent review${RESET}\n`,
    );
    console.log('Suggested allowlist entry:');
    console.log(
      JSON.stringify(
        {
          [pkg]: {
            repo: repoUrl.replace(/^git\+/, '').replace(/\.git$/, ''),
            publisher: maintainers.split(', ')[0],
            weeklyDownloads,
            versions,
            verified: new Date().toISOString().split('T')[0],
          },
        },
        null,
        2,
      ),
    );
    console.log();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
