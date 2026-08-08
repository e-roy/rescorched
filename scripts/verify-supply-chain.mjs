#!/usr/bin/env node
/**
 * Supply-chain guard.
 *
 * TECH_STACK.md declares the defences below non-negotiable and says no agent
 * may weaken them. Declaring that in prose is not enforcement — this is.
 * It runs as part of `pnpm check` and as its own CI step, so weakening any of
 * them turns the build red immediately rather than being noticed months later.
 *
 * Deliberately dependency-free (no YAML parser, no glob): a script that guards
 * the dependency tree should not add to it.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The floor, in minutes. 10080 = 7 days. Raising it is fine; lowering is not. */
const MIN_RELEASE_AGE = 10080;

/**
 * The ONLY packages allowed to run install scripts. Each was reviewed
 * individually; see the comment in pnpm-workspace.yaml. Adding to this list
 * requires the same scrutiny as adding a dependency.
 */
const ALLOWED_BUILD_SCRIPTS = new Set(['esbuild', 'workerd']);

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function read(relativePath) {
  const full = path.join(ROOT, relativePath);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

// ---------------------------------------------------------------------------
// 1. pnpm-workspace.yaml — the quarantine and registry rules.
// ---------------------------------------------------------------------------

const workspaceYaml = read('pnpm-workspace.yaml');
if (workspaceYaml === null) {
  fail('pnpm-workspace.yaml is missing.');
} else {
  const releaseAge = /^\s*minimumReleaseAge:\s*(\d+)/m.exec(workspaceYaml);
  if (releaseAge === null) {
    fail('pnpm-workspace.yaml does not set `minimumReleaseAge`.');
  } else if (Number(releaseAge[1]) < MIN_RELEASE_AGE) {
    fail(
      `minimumReleaseAge is ${releaseAge[1]} but must be at least ${MIN_RELEASE_AGE} ` +
        '(7 days). Pick an older package version or wait the quarantine out — ' +
        'never lower this.',
    );
  } else {
    notes.push(`minimumReleaseAge = ${releaseAge[1]} minutes`);
  }

  if (!/^\s*blockExoticSubdeps:\s*true/m.test(workspaceYaml)) {
    fail('pnpm-workspace.yaml must set `blockExoticSubdeps: true`.');
  }

  if (!/^\s*trustPolicy:\s*no-downgrade/m.test(workspaceYaml)) {
    fail('pnpm-workspace.yaml must set `trustPolicy: no-downgrade`.');
  }

  // These must never appear as actual settings. Checked against the file with
  // comments stripped, so the warning comments that NAME them do not trip it.
  const withoutComments = workspaceYaml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  for (const forbidden of [
    'dangerouslyAllowAllBuilds',
    'ignoreScripts',
    'neverBuiltDependencies',
  ]) {
    if (new RegExp(`^\\s*${forbidden}\\s*:`, 'm').test(withoutComments)) {
      fail(`pnpm-workspace.yaml sets forbidden option \`${forbidden}\`.`);
    }
  }

  // Lifecycle-script allowlist stays small and reviewed. pnpm expresses this
  // two ways — the `onlyBuiltDependencies` list and the `allowBuilds` map —
  // and both are checked, because either one can widen what gets to run.
  const listBlock = /^onlyBuiltDependencies:\s*$((?:\n\s*-\s*.+)*)/m.exec(workspaceYaml);
  const listed =
    listBlock === null ? [] : [...listBlock[1].matchAll(/-\s*(\S+)/g)].map((m) => m[1]);

  const mapBlock = /^allowBuilds:\s*$((?:\n\s+\S+:\s*.+)*)/m.exec(workspaceYaml);
  const approved =
    mapBlock === null
      ? []
      : [...mapBlock[1].matchAll(/^\s+(\S+):\s*(\S+)/gm)]
          .filter((match) => match[2] === 'true')
          .map((match) => match[1]);

  for (const name of new Set([...listed, ...approved])) {
    if (!ALLOWED_BUILD_SCRIPTS.has(name)) {
      fail(
        `\`${name}\` is allowed to run install scripts but is not on the reviewed ` +
          'allowlist in scripts/verify-supply-chain.mjs. Review it, then add it there too.',
      );
    }
  }
  notes.push(`install scripts allowed for: ${approved.join(', ') || '(none)'}`);
}

// ---------------------------------------------------------------------------
// 2. .npmrc — exact pins.
// ---------------------------------------------------------------------------

const npmrc = read('.npmrc');
if (npmrc === null) {
  fail('.npmrc is missing.');
} else if (!/^save-exact\s*=\s*true\s*$/m.test(npmrc)) {
  fail('.npmrc must set `save-exact=true` so new deps are pinned exactly.');
}

// ---------------------------------------------------------------------------
// 3. Every package.json — no floating ranges.
// ---------------------------------------------------------------------------

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function findPackageJsons(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      findPackageJsons(full, found);
    } else if (entry === 'package.json') {
      found.push(full);
    }
  }
  return found;
}

for (const file of findPackageJsons(ROOT)) {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${relative} is not valid JSON: ${error.message}`);
    continue;
  }

  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== 'string') continue;
      // Workspace links and the peer-dependency field are exempt: a peer range
      // describes what we are compatible WITH, not what gets installed.
      if (range.startsWith('workspace:') || range.startsWith('catalog:')) continue;
      if (field === 'peerDependencies') continue;

      if (/^[\^~]/.test(range) || range.includes('*') || range.includes('x')) {
        fail(
          `${relative}: ${field}.${name} = "${range}" is a floating range. ` +
            'TECH_STACK.md requires exact version pins.',
        );
      }
      if (/^(git|http|file|link):/i.test(range) || range.includes('://')) {
        fail(`${relative}: ${field}.${name} = "${range}" resolves outside the registry.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. The lockfile is committed.
// ---------------------------------------------------------------------------

if (!existsSync(path.join(ROOT, 'pnpm-lock.yaml'))) {
  fail('pnpm-lock.yaml is missing. It must be committed so CI can use --frozen-lockfile.');
}

const gitignore = read('.gitignore') ?? '';
if (/^\s*pnpm-lock\.yaml\s*$/m.test(gitignore)) {
  fail('.gitignore excludes pnpm-lock.yaml. The lockfile must be committed.');
}

// ---------------------------------------------------------------------------
// 5. The sim purity fence is still wired up in the ESLint config.
// ---------------------------------------------------------------------------

const eslintConfig = read('eslint.config.js') ?? '';
for (const required of ['Math', 'random', 'no-restricted-properties', 'packages/sim']) {
  if (!eslintConfig.includes(required)) {
    fail(
      `eslint.config.js no longer mentions "${required}" — the ban on ` +
        '`Math.random` / `Date.now` inside packages/sim may have been removed.',
    );
  }
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error('\nSupply-chain verification FAILED:\n');
  for (const message of failures) console.error(`  ✗ ${message}`);
  console.error(
    '\nThese settings are declared non-negotiable in TECH_STACK.md. ' +
      'If a package version is inside the quarantine window, pick an older\n' +
      'version or wait — do not lower the guard.\n',
  );
  process.exit(1);
}

console.log('Supply-chain verification passed.');
for (const note of notes) console.log(`  · ${note}`);
