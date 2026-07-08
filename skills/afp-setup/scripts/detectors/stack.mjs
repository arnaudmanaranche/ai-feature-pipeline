// Router / styling / backend library detection (dependency-only, no fs reads).

export function detectRouter(pkg) {
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

export function detectStyling(pkg) {
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

export function detectBackend(pkg) {
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
