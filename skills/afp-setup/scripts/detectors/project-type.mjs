// Mobile vs web project-type signal, used to gate mobile-only prompts/fields
// (app_id, paywall provider framing) that are meaningless for a webapp.

export function detectProjectType(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps?.['expo'] || deps?.['react-native']) return 'mobile';
  if (
    deps?.['next'] || deps?.['vite'] || deps?.['react-scripts'] ||
    deps?.['nuxt'] || deps?.['@nuxt/core'] || deps?.['@sveltejs/kit'] ||
    deps?.['astro'] || deps?.['@angular/core']
  ) {
    return 'web';
  }
  return 'unknown';
}
