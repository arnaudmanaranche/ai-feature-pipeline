#!/usr/bin/env node
// Auto-detect project stack from existing files — AI Feature Pipeline setup
// Usage: node detect-stack.mjs [--project-root=<path>]
// Output: JSON printed to stdout — consumed by afp-setup to pre-fill prompts
//
// Detection logic lives in ./detectors/*.mjs, one file per concern, so this
// file stays a thin composer instead of growing unbounded every time a new
// stack signal gets added.

import { readJson } from './detectors/fs-helpers.mjs';
import { detectPackageManager, detectRunScript, detectTypecheckCmd, detectLintCmd, detectTestCmd, detectFormatCmd, detectFormatWriteCmd } from './detectors/commands.mjs';
import { detectProjectName, detectAppId, detectGithubRepo, detectDefaultBranch } from './detectors/project.mjs';
import { detectRouter, detectStyling, detectBackend } from './detectors/stack.mjs';
import { detectAnalytics } from './detectors/analytics.mjs';
import { detectPaywall } from './detectors/paywall.mjs';
import { detectErrorTracking } from './detectors/error-tracking.mjs';
import { detectE2E } from './detectors/e2e.mjs';
import { detectLocales } from './detectors/locales.mjs';
import { detectSourceDirs, detectSkipDirs, detectSourceExtensions } from './detectors/source-layout.mjs';

const ROOT = (() => {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--project-root=(.+)$/);
    if (m) return m[1];
  }
  return process.cwd();
})();

const pkg = readJson(ROOT, 'package.json');
const e2e = detectE2E(ROOT);
const { locales, dir: localeDir } = detectLocales(ROOT);
const sourceDirs = detectSourceDirs(pkg, ROOT);
const skipDirs = detectSkipDirs(pkg, ROOT);
const sourceExtensions = detectSourceExtensions(pkg);
const packageManager = detectPackageManager(ROOT);

const detected = {
  project_name:       detectProjectName(pkg, ROOT),
  app_id:             detectAppId(pkg, ROOT),
  github_repo:        detectGithubRepo(ROOT),
  package_manager:    packageManager,
  run_script:         detectRunScript(pkg),
  typecheck_cmd:      detectTypecheckCmd(pkg, packageManager),
  lint_cmd:           detectLintCmd(pkg, packageManager),
  test_cmd:           detectTestCmd(pkg, packageManager),
  format_cmd:         detectFormatCmd(pkg, packageManager),
  format_write_cmd:   detectFormatWriteCmd(pkg, packageManager),
  default_branch:     detectDefaultBranch(ROOT),
  branch_prefix:      'feat',
  locales,
  locale_dir:         localeDir,
  analytics_provider: detectAnalytics(pkg, ROOT),
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
