#!/usr/bin/env node
// Auto-rebuild .ai/context.json from source files — AI Feature Pipeline module
// Usage: node rebuild-context.mjs [--project-root=<path>]

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname, basename } from 'path';

const ROOT = (() => {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--project-root=(.+)$/);
    if (m) return m[1];
  }
  return process.cwd();
})();
const SKIP_FILES = new Set(['.DS_Store']);

// Load config
let CONFIG;
try {
  CONFIG = JSON.parse(readFileSync(join(ROOT, '.ai/config.json'), 'utf-8'));
} catch {
  CONFIG = {
    sourceDirs: ['src'],
    skipDirs: ['node_modules', 'dist', 'build'],
    stack: { router: 'react-router', styling: 'CSS', backend: '' },
  };
}
const SKIP_DIRS = new Set(CONFIG.skipDirs || ['node_modules', 'dist', 'build']);
const WATCH_DIRS = CONFIG.sourceDirs || ['src'];

function globFiles(dir, base = dir) {
  const files = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (SKIP_FILES.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry) && !entry.startsWith('.')) {
          files.push(...globFiles(full, base));
        }
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}

function extractImports(content, filePath) {
  const imports = new Set();
  const regex = /from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    imports.add(match[1]);
  }
  // Also catch require()
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.add(match[1]);
  }
  return [...imports];
}

function extractExports(content, filePath) {
  const exports = [];
  const funcRegex = /export\s+(?:default\s+)?function\s+(\w+)/g;
  const constRegex = /export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/g;
  const interfaceRegex = /export\s+(?:default\s+)?interface\s+(\w+)/g;
  const typeRegex = /export\s+(?:default\s+)?type\s+(\w+)/g;
  const classRegex = /export\s+(?:default\s+)?class\s+(\w+)/g;

  let match;
  while ((match = funcRegex.exec(content)) !== null)
    exports.push({ name: match[1], type: 'function' });
  while ((match = constRegex.exec(content)) !== null)
    exports.push({ name: match[1], type: 'const' });
  while ((match = interfaceRegex.exec(content)) !== null)
    exports.push({ name: match[1], type: 'interface' });
  while ((match = typeRegex.exec(content)) !== null)
    exports.push({ name: match[1], type: 'type' });
  while ((match = classRegex.exec(content)) !== null)
    exports.push({ name: match[1], type: 'class' });

  return exports;
}

function toLocalPath(filePath) {
  return relative(ROOT, filePath);
}

// ---- Main ----

const allFiles = [];
for (const dir of WATCH_DIRS) {
  allFiles.push(...globFiles(join(ROOT, dir)));
}

const architectureMap = {};
const moduleMap = {};
const apiMap = {};
const dependencyMap = {};
const symbolIndex = {};
const fileCount = allFiles.length;

for (const file of allFiles) {
  const localPath = toLocalPath(file);
  const content = readFileSync(file, 'utf-8');

  // Architecture map: group by filename key
  const key = basename(file);
  if (!architectureMap[key]) architectureMap[key] = [];
  architectureMap[key].push(localPath);

  // Module map: same
  if (!moduleMap[key]) moduleMap[key] = [];
  moduleMap[key].push(localPath);

  // API map: exports per file
  const exports = extractExports(content, file);
  if (exports.length > 0) {
    apiMap[localPath] = exports.map(e => e.name);
  }

  // Dependency map: for each import, add this file as consumer
  const imports = extractImports(content, file);
  for (const imp of imports) {
    if (!dependencyMap[imp]) dependencyMap[imp] = [];
    if (!dependencyMap[imp].includes(localPath)) {
      dependencyMap[imp].push(localPath);
    }
  }

  // Symbol index
  for (const exp of exports) {
    symbolIndex[exp.name] = { definitionPath: localPath, type: exp.type };
  }
}

const output = {
  schemaVersion: 1,
  architectureMap,
  moduleMap,
  apiMap,
  dependencyMap,
  fileCount,
  symbolIndex,
  conventions: {
    naming: [
      'camelCase for variables',
      'PascalCase for components',
      'kebab-case for files',
    ],
    patterns: [
      CONFIG.stack.router ? `${CONFIG.stack.router} for navigation` : '',
      CONFIG.stack.styling ? `${CONFIG.stack.styling} for styling` : '',
      CONFIG.stack.backend ? `${CONFIG.stack.backend} for backend` : '',
    ].filter(Boolean),
  },
};

writeFileSync(join(ROOT, '.ai/context.json'), JSON.stringify(output, null, 2));
console.log(
  `Rebuilt .ai/context.json — ${fileCount} files indexed, ${Object.keys(dependencyMap).length} unique imports, ${Object.keys(symbolIndex).length} symbols`
);
