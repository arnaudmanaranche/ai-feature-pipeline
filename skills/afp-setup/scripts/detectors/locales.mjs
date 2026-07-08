// i18n locale detection.

import { join } from 'path';
import { exists, ls, findFiles, isDirectory } from './fs-helpers.mjs';

export function detectLocales(root) {
  // Common i18n directory patterns
  const candidateDirs = [
    'i18n/locales', 'locales', 'src/i18n/locales', 'src/locales',
    'public/locales', 'messages', 'src/messages', 'assets/i18n',
  ];

  for (const dir of candidateDirs) {
    if (!exists(root, dir)) continue;
    const entries = ls(root, dir);
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
      return isDirectory(root, join(dir, e));
    });
    if (localeDirs.length > 0) {
      return { locales: localeDirs.join(','), dir };
    }
  }

  // Fallback: scan for any i18n-like directory
  const i18nDirs = findFiles(root, '.', (name, rel) => {
    return isDirectory(root, rel) && ['i18n', 'intl', 'translations', 'locales'].includes(name);
  }, 3);
  if (i18nDirs.length > 0) {
    return { locales: 'en', dir: i18nDirs[0] };
  }

  return { locales: 'en', dir: 'i18n/locales' };
}
