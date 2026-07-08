// Package manager + build/quality-gate command detection.

import { exists } from './fs-helpers.mjs';

export function detectPackageManager(root) {
  if (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) return 'bun';
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  return 'npm';
}

export function detectRunScript(pkg) {
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
export function runScriptPrefix(packageManager) {
  if (packageManager === 'yarn') return 'yarn run';
  if (packageManager === 'bun') return 'bun run';
  return `${packageManager} run`; // npm run / pnpm run
}

export function detectTypecheckCmd(pkg, packageManager) {
  const scripts = pkg?.scripts || {};
  const prefix = runScriptPrefix(packageManager);
  for (const key of ['typecheck', 'type-check', 'typescript', 'tsc', 'ts']) {
    if (scripts[key]) return `${prefix} ${key}`;
  }
  return 'tsc --noEmit';
}

export function detectLintCmd(pkg, packageManager) {
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

export function detectTestCmd(pkg, packageManager) {
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

export function detectFormatCmd(pkg, packageManager) {
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

export function detectFormatWriteCmd(pkg, packageManager) {
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
