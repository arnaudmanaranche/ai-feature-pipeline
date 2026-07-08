// Source directory layout, skip dirs, and indexed file extensions.

import { exists } from './fs-helpers.mjs';

export function detectSourceDirs(pkg, root) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  // React Native / Expo: source is typically at root-level 'app' (expo-router) or 'src'
  if (deps?.['expo-router'] && exists(root, 'app')) {
    return ['app', 'components', 'hooks', 'lib'].filter(d => exists(root, d));
  }
  if (exists(root, 'src')) return ['src'];
  if (exists(root, 'app') && exists(root, 'pages')) return ['app', 'pages']; // Next.js app + pages hybrid
  if (exists(root, 'app')) return ['app'];
  if (exists(root, 'pages')) return ['pages'];
  return ['src'];
}

export function detectSkipDirs(pkg, root) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const base = ['node_modules', 'dist', 'build', '.git'];
  if (deps?.['react-native'] || deps?.['expo']) {
    base.push('ios', 'android', '.expo');
  }
  if (deps?.['next']) base.push('.next');
  if (exists(root, '.svelte-kit')) base.push('.svelte-kit');
  if (exists(root, '.nuxt')) base.push('.nuxt');
  return base;
}

export function detectSourceExtensions(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const exts = ['.ts', '.tsx'];
  if (!deps?.['typescript'] && (deps?.['react'] || deps?.['vue'])) {
    exts.push('.js', '.jsx');
  }
  if (deps?.['vue']) exts.push('.vue');
  if (deps?.['svelte']) exts.push('.svelte');
  return exts;
}
