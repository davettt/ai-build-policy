#!/usr/bin/env node

/**
 * Bootstrap an allowed-packages.json from a project's current package.json.
 * Queries npm registry for metadata on each package.
 *
 * Usage: node bootstrap-allowlist.js [path-to-project]
 *        Defaults to current directory.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const projectDir = process.argv[2] || '.';
const pkgPath = path.join(projectDir, 'package.json');
const outputPath = path.join(projectDir, 'allowed-packages.json');

if (!fs.existsSync(pkgPath)) {
  console.error(`No package.json found at ${pkgPath}`);
  process.exit(1);
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
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];

  console.log(`Bootstrapping allowlist for ${allDeps.length} packages...\n`);

  const allowlist = {};
  const flags = [];

  for (const dep of allDeps.sort()) {
    process.stdout.write(`  ${dep}... `);

    const [registry, downloads] = await Promise.all([
      fetch(`https://registry.npmjs.org/${encodeURIComponent(dep)}`),
      fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(dep)}`),
    ]);

    if (!registry) {
      console.log('NOT FOUND');
      flags.push({ name: dep, reason: 'not found on npm registry' });
      continue;
    }

    const versions = Object.keys(registry.versions || {}).length;
    const repoUrl =
      typeof registry.repository === 'string'
        ? registry.repository
        : registry.repository?.url || '';
    const cleanRepo = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
    const publisher = (registry.maintainers || [])[0]?.name || 'unknown';
    const weeklyDownloads = downloads?.downloads || 0;

    const latest = registry['dist-tags']?.latest;
    const timeData = registry.time || {};
    const latestPublishDate = latest && timeData[latest] ? timeData[latest] : null;
    const lastPubDate = latestPublishDate ? latestPublishDate.split('T')[0] : null;
    const deprecated =
      latest && registry.versions && registry.versions[latest]
        ? registry.versions[latest].deprecated || null
        : null;

    let maintenance = 'maintained';
    if (deprecated) {
      maintenance = 'deprecated';
    } else if (latestPublishDate) {
      const days = Math.floor((Date.now() - new Date(latestPublishDate)) / 86400000);
      if (days > 540) maintenance = 'dormant';
    }

    const entry = {
      repo: cleanRepo || 'UNKNOWN',
      publisher,
      weeklyDownloads,
      versions,
      verified: new Date().toISOString().split('T')[0],
      lastPublished: lastPubDate,
      repoArchived: false,
      maintenance,
      successor: deprecated || null,
      notes: '',
    };

    const issueList = [];
    if (versions <= 1) issueList.push('single version');
    if (weeklyDownloads < 100) issueList.push('very low downloads');
    if (!cleanRepo) issueList.push('no repo URL');
    if (maintenance === 'deprecated') issueList.push('deprecated');
    if (maintenance === 'dormant') issueList.push('dormant (18+ months since last publish)');

    if (issueList.length > 0) {
      console.log(`FLAGGED (${issueList.join(', ')})`);
      flags.push({ name: dep, reason: issueList.join(', '), entry });
    } else {
      console.log('OK');
    }

    allowlist[dep] = entry;
  }

  fs.writeFileSync(outputPath, JSON.stringify(allowlist, null, 2) + '\n');
  console.log(`\nAllowlist written to ${outputPath}`);

  if (flags.length > 0) {
    console.log(`\n⚠ ${flags.length} package(s) flagged for manual review:`);
    for (const f of flags) {
      console.log(`  - ${f.name}: ${f.reason}`);
    }
    console.log('\nReview these before committing the allowlist.');
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
