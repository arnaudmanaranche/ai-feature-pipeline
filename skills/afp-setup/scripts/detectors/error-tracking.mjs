// Error tracking / crash reporting provider detection.

export function detectErrorTracking(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps?.['@sentry/react'] || deps?.['@sentry/react-native'] || deps?.['@sentry/nextjs']) return 'sentry';
  if (deps?.['@bugsnag/js'] || deps?.['@bugsnag/react-native']) return 'bugsnag';
  if (deps?.['@datadog/browser-rum'] || deps?.['@datadog/mobile-react-native']) return 'datadog';
  if (deps?.['rollbar']) return 'rollbar';
  if (deps?.['highlight.run']) return 'highlight';
  return '';
}
