// E2E testing framework + directory detection.

import { exists, findFiles } from './fs-helpers.mjs';

export function detectE2E(root) {
  // Check for framework-specific directories and config files
  if (
    exists(root, 'e2e/maestro') ||
    findFiles(root, '.', n => n.endsWith('.yaml') && n.includes('maestro'), 2).length > 0
  ) {
    return { framework: 'maestro', dir: 'e2e/maestro' };
  }
  if (exists(root, 'playwright.config.ts') || exists(root, 'playwright.config.js')) {
    const dir = exists(root, 'e2e') ? 'e2e' : exists(root, 'tests') ? 'tests' : 'e2e';
    return { framework: 'playwright', dir };
  }
  if (exists(root, 'cypress.config.ts') || exists(root, 'cypress.config.js') || exists(root, 'cypress')) {
    return { framework: 'cypress', dir: 'cypress/e2e' };
  }
  if (exists(root, 'detox.config.js') || exists(root, 'detox.config.ts') || exists(root, '.detoxrc.js')) {
    return { framework: 'detox', dir: 'e2e' };
  }
  if (exists(root, 'wdio.conf.ts') || exists(root, 'wdio.conf.js')) {
    return { framework: 'webdriverio', dir: 'test' };
  }
  return { framework: '', dir: 'e2e' };
}
