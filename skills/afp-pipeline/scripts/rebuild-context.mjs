#!/usr/bin/env node
// Rebuild .ai/context.json — repo memory for the AFP pipeline.
// Usage: node rebuild-context.mjs [--project-root=<path>]
//
// Two things changed from the original hand-rolled-regex version:
//
// 1. Accuracy: when the target project has `typescript` installed, exports
//    and imports are extracted via the TypeScript compiler API (a real AST)
//    instead of regexes that silently miss re-exports (`export * from`),
//    `export { a as b }`, enums, and `export default class/function`. Pure
//    JS projects (or ones without `typescript` installed) fall back to the
//    regex extractor, which still works, just less precisely.
//
// 2. Incrementality: this is meant to be *repo memory*, not a from-scratch
//    scan every time. Each file's mtime is fingerprinted; unchanged files
//    reuse their previously extracted exports/imports instead of being
//    reparsed, and the aggregated maps (apiMap, dependencyMap, symbolIndex)
//    are always rebuilt fresh from the current file set, so deleted files
//    never leave stale entries behind.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from 'fs';
import { join, relative, dirname, basename } from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

function getRoot() {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--project-root=(.+)$/);
    if (m) return m[1];
  }
  return process.cwd();
}

function loadConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, '.ai/config.json'), 'utf-8'));
  } catch {
    return {
      sourceDirs: ['src'],
      skipDirs: ['node_modules', 'dist', 'build'],
      sourceExtensions: ['.ts', '.tsx', '.js', '.jsx'],
      stack: { router: 'react-router', styling: 'CSS', backend: '' },
    };
  }
}

function loadPreviousContext(root) {
  try {
    return JSON.parse(readFileSync(join(root, '.ai/context.json'), 'utf-8'));
  } catch {
    return null;
  }
}

// Attempts to load the target project's own `typescript` install for
// AST-accurate parsing. Returns null (triggering the regex fallback) if the
// project has no TypeScript dependency — this module must stay usable in
// plain-JS projects without forcing a new mandatory dependency on them.
async function tryLoadTypescript(root) {
  try {
    const require = createRequire(join(root, 'package.json'));
    const tsEntry = require.resolve('typescript');
    const mod = await import(pathToFileURL(tsEntry).href);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function globFiles(dir, skipDirs, sourceExts) {
  const files = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === '.DS_Store') continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!skipDirs.has(entry) && !entry.startsWith('.')) {
          files.push(...globFiles(full, skipDirs, sourceExts));
        }
      } else if ([...sourceExts].some(ext => entry.endsWith(ext))) {
        files.push(full);
      }
    }
  } catch {
    // directory doesn't exist — fine, sourceDirs are best-effort
  }
  return files;
}

// --- Regex fallback extraction (no `typescript` available) ---

function extractImportsRegex(content) {
  const imports = new Set();
  for (const m of content.matchAll(/from\s+['"]([^'"]+)['"]/g)) imports.add(m[1]);
  for (const m of content.matchAll(/require\(['"]([^'"]+)['"]\)/g)) imports.add(m[1]);
  return [...imports];
}

function extractExportsRegex(content) {
  const exports = [];
  const patterns = [
    [/export\s+(?:default\s+)?function\s+(\w+)/g, 'function'],
    [/export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/g, 'const'],
    [/export\s+(?:default\s+)?interface\s+(\w+)/g, 'interface'],
    [/export\s+(?:default\s+)?type\s+(\w+)/g, 'type'],
    [/export\s+(?:default\s+)?class\s+(\w+)/g, 'class'],
    [/export\s+(?:default\s+)?enum\s+(\w+)/g, 'enum'],
  ];
  for (const [regex, type] of patterns) {
    for (const m of content.matchAll(regex)) exports.push({ name: m[1], type });
  }
  return exports;
}

// --- AST extraction (typescript compiler API available) ---

function hasModifier(ts, node, kind) {
  return (ts.getModifiers?.(node) ?? node.modifiers ?? []).some(
    m => m.kind === kind
  );
}

function extractFromSourceFileAst(ts, sourceFile) {
  const exports = [];
  const imports = new Set();

  const pushDeclExport = (name, type) => {
    if (name) exports.push({ name, type });
  };

  for (const node of sourceFile.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
      continue;
    }

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.add(node.moduleSpecifier.text);
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          pushDeclExport(el.name.text, 'reexport');
        }
      } else if (!node.exportClause) {
        // `export * from '...'` — a wildcard re-export, no concrete symbol
        // name to record, but the dependency edge above still matters.
      }
      continue;
    }

    if (ts.isExportAssignment(node)) {
      // `export default <expr>` — only worth naming when it's a bare identifier.
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : 'default';
      pushDeclExport(name, 'default');
      continue;
    }

    const isExported = hasModifier(ts, node, ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;

    if (ts.isFunctionDeclaration(node)) {
      pushDeclExport(node.name?.text ?? 'default', 'function');
    } else if (ts.isClassDeclaration(node)) {
      pushDeclExport(node.name?.text ?? 'default', 'class');
    } else if (ts.isInterfaceDeclaration(node)) {
      pushDeclExport(node.name.text, 'interface');
    } else if (ts.isTypeAliasDeclaration(node)) {
      pushDeclExport(node.name.text, 'type');
    } else if (ts.isEnumDeclaration(node)) {
      pushDeclExport(node.name.text, 'enum');
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          pushDeclExport(decl.name.text, 'const');
        }
      }
    }
  }

  // require() calls — still worth tracking even in mostly-ESM TS codebases.
  for (const m of sourceFile.text.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    imports.add(m[1]);
  }

  return { exports, imports: [...imports] };
}

function extractFile(content, localPath, ts) {
  if (ts) {
    try {
      const sourceFile = ts.createSourceFile(
        localPath,
        content,
        ts.ScriptTarget.Latest,
        true,
        localPath.endsWith('.tsx') || localPath.endsWith('.jsx')
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS
      );
      return extractFromSourceFileAst(ts, sourceFile);
    } catch {
      // fall through to regex on a parse error (e.g. unusual syntax)
    }
  }
  return { exports: extractExportsRegex(content), imports: extractImportsRegex(content) };
}

// --- Incremental build ---
//
// Pure function — no fs access — so it's fully unit-testable with synthetic
// file lists and a synthetic `previous` context.
function buildContext({ files, previous, ts, conventions }) {
  const perFileExports = {};
  const perFileImports = {};
  const fileFingerprints = {};
  let reused = 0;
  let parsed = 0;

  for (const file of files) {
    fileFingerprints[file.localPath] = file.mtimeMs;
    const cacheHit =
      previous?.fileFingerprints?.[file.localPath] === file.mtimeMs &&
      previous?.perFileExports &&
      Object.prototype.hasOwnProperty.call(previous.perFileExports, file.localPath) &&
      previous?.perFileImports &&
      Object.prototype.hasOwnProperty.call(previous.perFileImports, file.localPath);

    if (cacheHit) {
      perFileExports[file.localPath] = previous.perFileExports[file.localPath];
      perFileImports[file.localPath] = previous.perFileImports[file.localPath];
      reused++;
    } else {
      const { exports, imports } = extractFile(file.content, file.localPath, ts);
      perFileExports[file.localPath] = exports;
      perFileImports[file.localPath] = imports;
      parsed++;
    }
  }

  // Aggregated maps are always rebuilt fresh from the current file set, so
  // a deleted file's symbols/imports never linger as stale entries.
  const architectureMap = {};
  const moduleMap = {};
  const apiMap = {};
  const dependencyMap = {};
  const symbolIndex = {};

  for (const file of files) {
    const key = basename(file.localPath);
    (architectureMap[key] ??= []).push(file.localPath);
    (moduleMap[key] ??= []).push(file.localPath);

    const exportNames = perFileExports[file.localPath].map(e => e.name);
    if (exportNames.length > 0) apiMap[file.localPath] = exportNames;

    for (const exp of perFileExports[file.localPath]) {
      symbolIndex[exp.name] = { definitionPath: file.localPath, type: exp.type };
    }

    for (const imp of perFileImports[file.localPath]) {
      const consumers = (dependencyMap[imp] ??= []);
      if (!consumers.includes(file.localPath)) consumers.push(file.localPath);
    }
  }

  return {
    schemaVersion: 2,
    generatedWith: ts ? 'typescript-ast' : 'regex-fallback',
    architectureMap,
    moduleMap,
    apiMap,
    dependencyMap,
    fileCount: files.length,
    symbolIndex,
    conventions: conventions ?? {},
    perFileExports,
    perFileImports,
    fileFingerprints,
    stats: { filesReusedFromCache: reused, filesParsed: parsed },
  };
}

function toLocalPath(root, filePath) {
  return relative(root, filePath);
}

async function main() {
  const root = getRoot();
  const config = loadConfig(root);
  const skipDirs = new Set(config.skipDirs || ['node_modules', 'dist', 'build']);
  const sourceExts = new Set(config.sourceExtensions || ['.ts', '.tsx', '.js', '.jsx']);
  const watchDirs = config.sourceDirs || ['src'];

  const previous = loadPreviousContext(root);
  const ts = await tryLoadTypescript(root);

  const allFilePaths = [];
  for (const dir of watchDirs) {
    allFilePaths.push(...globFiles(join(root, dir), skipDirs, sourceExts));
  }

  const files = allFilePaths.map(fullPath => {
    const localPath = toLocalPath(root, fullPath);
    return {
      localPath,
      content: readFileSync(fullPath, 'utf-8'),
      mtimeMs: statSync(fullPath).mtimeMs,
    };
  });

  const conventions = {
    naming: [
      'camelCase for variables',
      'PascalCase for components',
      'kebab-case for files',
    ],
    patterns: [
      config.stack?.router ? `${config.stack.router} for navigation` : '',
      config.stack?.styling ? `${config.stack.styling} for styling` : '',
      config.stack?.backend ? `${config.stack.backend} for backend` : '',
    ].filter(Boolean),
  };

  const output = buildContext({ files, previous, ts, conventions });

  writeFileSync(join(root, '.ai/context.json'), JSON.stringify(output, null, 2));
  console.log(
    `Rebuilt .ai/context.json — ${output.fileCount} files ` +
      `(${output.stats.filesReusedFromCache} reused, ${output.stats.filesParsed} parsed via ${output.generatedWith}), ` +
      `${Object.keys(output.dependencyMap).length} unique imports, ${Object.keys(output.symbolIndex).length} symbols`
  );
}

const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main();
}

export {
  extractImportsRegex,
  extractExportsRegex,
  extractFromSourceFileAst,
  extractFile,
  buildContext,
  tryLoadTypescript,
};
