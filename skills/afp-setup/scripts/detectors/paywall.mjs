// Paywall / in-app-purchase provider detection.

export function detectPaywall(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps?.['react-native-purchases'] || deps?.['@revenuecat/purchases-js']) return 'revenuecat';
  if (deps?.['expo-in-app-purchases']) return 'expo-iap';
  if (deps?.['react-native-iap']) return 'react-native-iap';
  if (deps?.['@stripe/stripe-js'] || deps?.['@stripe/react-stripe-js']) return 'stripe';
  if (deps?.['lemonsqueezy']) return 'lemonsqueezy';
  return '';
}
