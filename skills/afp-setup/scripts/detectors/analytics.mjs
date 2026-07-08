// Analytics provider detection.

import { exists } from './fs-helpers.mjs';

export function detectAnalytics(pkg, root) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps?.['posthog-js'] || deps?.['posthog-react-native']) return 'posthog';
  if (deps?.['@segment/analytics-next'] || deps?.['@segment/analytics-react-native']) return 'segment';
  if (deps?.['mixpanel-browser'] || deps?.['mixpanel-react-native']) return 'mixpanel';
  if (deps?.['@amplitude/analytics-browser'] || deps?.['@amplitude/analytics-react-native']) return 'amplitude';
  if (deps?.['@rudderstack/analytics-js'] || deps?.['@rudderstack/rudder-sdk-react-native']) return 'rudderstack';
  if (deps?.['firebase'] && exists(root, 'src')) return 'firebase-analytics';
  return '';
}
