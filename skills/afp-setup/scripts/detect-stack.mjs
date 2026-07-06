#!/usr/bin/env node
// Auto-detect project stack from existing files — AI Feature Pipeline setup
// Usage: node detect-stack.mjs [--project-root=<path>]
// Output: JSON printed to stdout — consumed by afp-setup to pre-fill prompts

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { join, extname, basename } from 'path';

const ROOT = (() => {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--project-root=(.+)$/);
    if (m) return m[1];
  }
  return process.cwd();
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson(path) {
  try {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf-8'));
  } catch {
    return null;
  }
}

function exists(...parts) {
  return existsSync(join(ROOT, ...parts));
}

function readText(path) {
  try {
    return readFileSync(join(ROOT, path), 'utf-8');
  } catch {
    return '';
  }
}

/** List immediate children of a directory (names only). Returns [] on error. */
function ls(dir) {
  try {
    return readdirSync(join(ROOT, dir));
  } catch {
    return [];
  }
}

/** Recursively find files matching a predicate, up to maxDepth. */
function findFiles(dir, predicate, maxDepth = 3, _depth = 0) {
  if (_depth > maxDepth) return [];
  const results = [];
  try {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'build', '.git'].includes(entry.name)) {
          results.push(...findFiles(rel, predicate, maxDepth, _depth + 1));
        }
      } else if (predicate(entry.name, rel)) {
        results.push(rel);
      }
    }
  } catch {}
  return results;
}

// ── Detection logic ───────────────────────────────────────────────────────────

function detectPackageManager() {
  if (exists('bun.lockb') || exists('bun.lock')) return 'bun';
  if (exists('pnpm-lock.yaml')) return 'pnpm';
  if (exists('yarn.lock')) return 'yarn';
  return 'npm';
}

function detectRunScript(pkg) {
  const devDeps = { ...pkg?.devDependencies, ...pkg?.dependencies };
  // Bare `tsx`/`ts-node` assumes a global install, which usually isn't
  // there — only trust the bare binary name when it's an actual project
  // dependency (resolvable from node_modules/.bin); otherwise fall back to
  // `npx tsx`, which fetches/runs it on demand without requiring the
  // target project to add a new dependency just for this module.
  if (devDeps?.['tsx']) return 'tsx';
  if (devDeps?.['ts-node']) return 'ts-node';
  if (devDeps?.['bun']) return 'bun run';
  return 'npx tsx';
}

// `npm run <script>` was hardcoded regardless of the actually-detected
// package manager below — harmless-looking but wrong for any pnpm/yarn/bun
// project (found by running this against a real pnpm workspace: it
// detected "pnpm" as the package manager one field over, then still
// produced "npm run lint" for the lint command).
function runScriptPrefix(packageManager) {
  if (packageManager === 'yarn') return 'yarn run';
  if (packageManager === 'bun') return 'bun run';
  return `${packageManager} run`; // npm run / pnpm run
}

function detectTypecheckCmd(pkg, packageManager) {
  const scripts = pkg?.scripts || {};
  const prefix = runScriptPrefix(packageManager);
  for (const key of ['typecheck', 'type-check', 'typescript', 'tsc', 'ts']) {
    if (scripts[key]) return `${prefix} ${key}`;
  }
  return 'tsc --noEmit';
}

function detectLintCmd(pkg, packageManager) {
  const scripts = pkg?.scripts || {};
  const prefix = runScriptPrefix(packageManager);
  for (const key of ['lint', 'eslint', 'lint:check']) {
    if (scripts[key]) return `${prefix} ${key}`;
  }
  const devDeps = { ...pkg?.devDependencies, ...pkg?.dependencies };
  if (devDeps?.['biome']) return 'biome lint .';
  if (devDeps?.['eslint']) return 'eslint .';
  return 'eslint .';
}

function detectTestCmd(pkg, packageManager) {
  const scripts = pkg?.scripts || {};
  const prefix = runScriptPrefix(packageManager);
  // `npm init`'s default placeholder always exits 1 — using it as a quality
  // gate would fail every single feature, so it's deliberately excluded
  // rather than trusted just because a "test" script key exists.
  const testScript = scripts['test'];
  if (testScript && !/no test specified/i.test(testScript)) {
    return `${packageManager} test`;
  }
  for (const key of ['test:unit', 'test:ci']) {
    if (scripts[key]) return `${prefix} ${key}`;
  }
  return '';
}

function detectFormatCmd(pkg, packageManager) {
  const scripts = pkg?.scripts || {};
  const prefix = runScriptPrefix(packageManager);
  for (const key of ['format:check', 'fmt:check', 'format']) {
    if (scripts[key]) return `${prefix} ${key}`;
  }
  const devDeps = { ...pkg?.devDependencies, ...pkg?.dependencies };
  if (devDeps?.['biome']) return 'biome format .';
  if (devDeps?.['prettier']) return 'prettier --check .';
  return 'prettier --check .';
}

function detectFormatWriteCmd(pkg, packageManager) {
  const scripts = pkg?.scripts || {};
  const prefix = runScriptPrefix(packageManager);
  for (const key of ['format:write', 'fmt', 'fmt:write']) {
    if (scripts[key]) return `${prefix} ${key}`;
  }
  const devDeps = { ...pkg?.devDependencies, ...pkg?.dependencies };
  if (devDeps?.['biome']) return 'biome format --write .';
  if (devDeps?.['prettier']) return 'prettier --write .';
  return 'prettier --write .';
}

function detectRouter(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps?.['expo-router']) return 'expo-router';
  if (deps?.['react-navigation'] || deps?.['@react-navigation/native']) return 'react-navigation';
  if (deps?.['next']) return 'next';
  if (deps?.['@tanstack/router'] || deps?.['@tanstack/react-router']) return '@tanstack/router';
  if (deps?.['react-router-dom'] || deps?.['react-router']) return 'react-router';
  if (deps?.['wouter']) return 'wouter';
  if (deps?.['vue-router']) return 'vue-router';
  if (deps?.['@nuxt/core'] || deps?.['nuxt']) return 'nuxt';
  return '';
}

function detectStyling(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps?.['nativewind']) return 'nativewind';
  if (deps?.['tailwindcss']) return 'tailwind';
  if (deps?.['styled-components']) return 'styled-components';
  if (deps?.['@emotion/react'] || deps?.['@emotion/styled']) return 'emotion';
  if (deps?.['stitches'] || deps?.['@stitches/react']) return 'stitches';
  if (deps?.['@vanilla-extract/css']) return 'vanilla-extract';
  if (deps?.['react-native']) return 'StyleSheet'; // RN default
  return 'CSS';
}

function detectBackend(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps?.['@supabase/supabase-js']) return 'supabase';
  if (deps?.['firebase'] || deps?.['@firebase/app']) return 'firebase';
  if (deps?.['@aws-amplify/core'] || deps?.['aws-amplify']) return 'amplify';
  if (deps?.['convex']) return 'convex';
  if (deps?.['@prisma/client']) return 'prisma';
  if (deps?.['drizzle-orm']) return 'drizzle';
  if (deps?.['mongoose']) return 'mongoose';
  if (deps?.['pg'] || deps?.['postgres']) return 'postgres';
  return '';
}

function detectAnalytics(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps?.['posthog-js'] || deps?.['posthog-react-native']) return 'posthog';
  if (deps?.['@segment/analytics-next'] || deps?.['@segment/analytics-react-native']) return 'segment';
  if (deps?.['mixpanel-browser'] || deps?.['mixpanel-react-native']) return 'mixpanel';
  if (deps?.['@amplitude/analytics-browser'] || deps?.['@amplitude/analytics-react-native']) return 'amplitude';
  if (deps?.['@rudderstack/analytics-js'] || deps?.['@rudderstack/rudder-sdk-react-native']) return 'rudderstack';
  if (deps?.['firebase'] && exists('src')) return 'firebase-analytics';
  return '';
}

function detectPaywall(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps?.['react-native-purchases'] || deps?.['@revenuecat/purchases-js']) return 'revenuecat';
  if (deps?.['expo-in-app-purchases']) return 'expo-iap';
  if (deps?.['react-native-iap']) return 'react-native-iap';
  if (deps?.['@stripe/stripe-js'] || deps?.['@stripe/react-stripe-js']) return 'stripe';
  if (deps?.['lemonsqueezy']) return 'lemonsqueezy';
  return '';
}

function detectErrorTracking(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps?.['@sentry/react'] || deps?.['@sentry/react-native'] || deps?.['@sentry/nextjs']) return 'sentry';
  if (deps?.['@bugsnag/js'] || deps?.['@bugsnag/react-native']) return 'bugsnag';
  if (deps?.['@datadog/browser-rum'] || deps?.['@datadog/mobile-react-native']) return 'datadog';
  if (deps?.['rollbar']) return 'rollbar';
  if (deps?.['highlight.run']) return 'highlight';
  return '';
}

function detectE2E() {
  // Check for framework-specific directories and config files
  if (exists('e2e/maestro') || findFiles('.', n => n.endsWith('.yaml') && n.includes('maestro'), 2).length > 0) {
    return { framework: 'maestro', dir: 'e2e/maestro' };
  }
  if (exists('playwright.config.ts') || exists('playwright.config.js')) {
    const dir = exists('e2e') ? 'e2e' : exists('tests') ? 'tests' : 'e2e';
    return { framework: 'playwright', dir };
  }
  if (exists('cypress.config.ts') || exists('cypress.config.js') || exists('cypress')) {
    return { framework: 'cypress', dir: 'cypress/e2e' };
  }
  if (exists('detox.config.js') || exists('detox.config.ts') || exists('.detoxrc.js')) {
    return { framework: 'detox', dir: 'e2e' };
  }
  if (exists('wdio.conf.ts') || exists('wdio.conf.js')) {
    return { framework: 'webdriverio', dir: 'test' };
  }
  return { framework: '', dir: 'e2e' };
}

function detectLocales() {
  // Common i18n directory patterns
  const candidateDirs = [
    'i18n/locales', 'locales', 'src/i18n/locales', 'src/locales',
    'public/locales', 'messages', 'src/messages', 'assets/i18n',
  ];

  for (const dir of candidateDirs) {
    if (!exists(dir)) continue;
    const entries = ls(dir);
    // Look for locale files: en.ts, fr.json, en-US.ts, etc.
    const localeFiles = entries.filter(e =>
      /^[a-z]{2}(-[A-Z]{2})?(-[a-z]+)?\.(ts|tsx|js|json)$/.test(e)
    );
    if (localeFiles.length > 0) {
      const locales = localeFiles.map(f => f.replace(/\.(ts|tsx|js|json)$/, ''));
      return { locales: locales.join(','), dir };
    }
    // Look for locale subdirectories: en/, fr/, etc.
    const localeDirs = entries.filter(e => {
      if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(e)) return false;
      try {
        return statSync(join(ROOT, dir, e)).isDirectory();
      } catch { return false; }
    });
    if (localeDirs.length > 0) {
      return { locales: localeDirs.join(','), dir };
    }
  }

  // Fallback: scan for any i18n-like directory
  const i18nDirs = findFiles('.', (name, rel) => {
    try { return statSync(join(ROOT, rel)).isDirectory() && ['i18n', 'intl', 'translations', 'locales'].includes(name); }
    catch { return false; }
  }, 3);
  if (i18nDirs.length > 0) {
    return { locales: 'en', dir: i18nDirs[0] };
  }

  return { locales: 'en', dir: 'i18n/locales' };
}

function detectProjectName(pkg) {
  if (pkg?.name) {
    // Convert package name to display name: my-app → My App
    return pkg.name
      .replace(/^@[^/]+\//, '') // strip scope
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  // Fall back to directory name
  return basename(ROOT)
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function detectAppId(pkg) {
  // expo app.json (static)
  const appJson = readJson('app.json');
  if (appJson?.expo?.android?.package) return appJson.expo.android.package;
  if (appJson?.expo?.ios?.bundleIdentifier) return appJson.expo.ios.bundleIdentifier;

  // expo app.config.ts / app.config.js (dynamic config — the modern Expo
  // default, and JS/TS, so not readable as JSON). Regex-extracted from the
  // raw text rather than imported/executed — this script only ever reads
  // files, never runs project code.
  for (const configFile of ['app.config.ts', 'app.config.js']) {
    const text = readText(configFile);
    const iosMatch = text.match(/bundleIdentifier\s*:\s*['"]([^'"]+)['"]/);
    if (iosMatch) return iosMatch[1];
    const androidMatch = text.match(/package\s*:\s*['"]([^'"]+)['"]/);
    if (androidMatch) return androidMatch[1];
  }

  // Capacitor
  const capacitorJson = readJson('capacitor.config.json');
  if (capacitorJson?.appId) return capacitorJson.appId;

  // Derive from package name
  if (pkg?.name) {
    const clean = pkg.name.replace(/^@[^/]+\//, '').replace(/[^a-z0-9]/g, '.');
    return `com.example.${clean}`;
  }
  return 'com.example.app';
}

function detectGithubRepo() {
  // Try to read from git remote
  const gitConfig = readText('.git/config');
  const match = gitConfig.match(/url\s*=\s*.*github\.com[:/]([^/\s]+\/[^\s.]+)/);
  if (match) return match[1].replace(/\.git$/, '');

  // Try package.json repository field
  return 'org/repo';
}

function detectDefaultBranch() {
  const gitHead = readText('.git/HEAD');
  const match = gitHead.match(/ref: refs\/heads\/(.+)/);
  return match?.[1]?.trim() || 'main';
}

function detectSourceDirs(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  // React Native / Expo: source is typically at root-level 'app' (expo-router) or 'src'
  if (deps?.['expo-router'] && exists('app')) return ['app', 'components', 'hooks', 'lib'].filter(d => exists(d));
  if (exists('src')) return ['src'];
  if (exists('app') && exists('pages')) return ['app', 'pages']; // Next.js app + pages hybrid
  if (exists('app')) return ['app'];
  if (exists('pages')) return ['pages'];
  return ['src'];
}

function detectSkipDirs(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const base = ['node_modules', 'dist', 'build', '.git'];
  if (deps?.['react-native'] || deps?.['expo']) {
    base.push('ios', 'android', '.expo');
  }
  if (deps?.['next']) base.push('.next');
  if (exists('.svelte-kit')) base.push('.svelte-kit');
  if (exists('.nuxt')) base.push('.nuxt');
  return base;
}

function detectSourceExtensions(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const exts = ['.ts', '.tsx'];
  if (!deps?.['typescript'] && (deps?.['react'] || deps?.['vue'])) {
    exts.push('.js', '.jsx');
  }
  if (deps?.['vue']) exts.push('.vue');
  if (deps?.['svelte']) exts.push('.svelte');
  return exts;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const pkg = readJson('package.json');
const e2e = detectE2E();
const { locales, dir: localeDir } = detectLocales();
const sourceDirs = detectSourceDirs(pkg);
const skipDirs = detectSkipDirs(pkg);
const sourceExtensions = detectSourceExtensions(pkg);
const packageManager = detectPackageManager();

const detected = {
  project_name:       detectProjectName(pkg),
  app_id:             detectAppId(pkg),
  github_repo:        detectGithubRepo(),
  package_manager:    packageManager,
  run_script:         detectRunScript(pkg),
  typecheck_cmd:      detectTypecheckCmd(pkg, packageManager),
  lint_cmd:           detectLintCmd(pkg, packageManager),
  test_cmd:           detectTestCmd(pkg, packageManager),
  format_cmd:         detectFormatCmd(pkg, packageManager),
  format_write_cmd:   detectFormatWriteCmd(pkg, packageManager),
  default_branch:     detectDefaultBranch(),
  branch_prefix:      'feat',
  locales,
  locale_dir:         localeDir,
  analytics_provider: detectAnalytics(pkg),
  paywall_provider:   detectPaywall(pkg),
  backend_service:    detectBackend(pkg),
  error_tracking:     detectErrorTracking(pkg),
  e2e_framework:      e2e.framework,
  e2e_dir:            e2e.dir,
  source_dirs:        sourceDirs.join(','),
  skip_dirs:          skipDirs.join(','),
  source_extensions:  sourceExtensions.join(','),
  router:             detectRouter(pkg),
  styling:            detectStyling(pkg),
};

// Print as JSON — afp-setup reads this to pre-fill prompts
process.stdout.write(JSON.stringify(detected, null, 2) + '\n');
