// Unit tests for rebuild-context.mjs — the "repo memory" builder.
// Run with: npm test (node --test)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractImportsRegex,
  extractExportsRegex,
  extractFile,
  buildContext,
  tryLoadTypescript,
} from '../skills/afp-pipeline/scripts/rebuild-context.mjs';

describe('regex fallback extraction', () => {
  test('extracts named and default exports by declaration kind', () => {
    const content = `
      export function useThing() {}
      export const CONFIG = {};
      export interface Props {}
      export type Id = string;
      export class Widget {}
      export default function App() {}
    `;
    const exports = extractExportsRegex(content);
    const byName = Object.fromEntries(exports.map(e => [e.name, e.type]));
    assert.equal(byName.useThing, 'function');
    assert.equal(byName.CONFIG, 'const');
    assert.equal(byName.Props, 'interface');
    assert.equal(byName.Id, 'type');
    assert.equal(byName.Widget, 'class');
    assert.equal(byName.App, 'function');
  });

  test('extracts import specifiers from both ESM and require()', () => {
    const content = `
      import { a } from 'lib-a';
      import b from "lib-b";
      const c = require('lib-c');
    `;
    assert.deepEqual(extractImportsRegex(content).sort(), ['lib-a', 'lib-b', 'lib-c']);
  });
});

describe('AST extraction (typescript compiler API)', () => {
  test('typescript resolves from this repo (devDependency)', async () => {
    const ts = await tryLoadTypescript(process.cwd());
    assert.ok(ts, 'typescript must be installed as a devDependency for these tests to be meaningful');
  });

  test('AST extraction handles what regex extraction cannot: re-exports and enums', async () => {
    const ts = await tryLoadTypescript(process.cwd());
    const content = `
      export * from './other';
      export { renamed as publicName } from './source';
      export enum Status { Active, Archived }
      export default class Service {}
    `;
    const { exports, imports } = extractFile(content, 'src/thing.ts', ts);
    const names = exports.map(e => e.name);
    assert.ok(names.includes('publicName'), 'named re-export should be captured');
    assert.ok(names.includes('Status'), 'enum export should be captured');
    assert.ok(names.includes('Service'), 'default class export should be captured');
    assert.deepEqual(imports.sort(), ['./other', './source']);
  });

  test('regex fallback (ts=null) still works for plain JS content', () => {
    const content = `export function plain() {}`;
    const { exports } = extractFile(content, 'src/plain.js', null);
    assert.deepEqual(exports, [{ name: 'plain', type: 'function' }]);
  });
});

describe('buildContext — incremental repo memory', () => {
  test('is deterministic: same files in produce the same aggregated maps', () => {
    const files = [
      { localPath: 'src/a.ts', content: `export const A = 1;`, mtimeMs: 100 },
      { localPath: 'src/b.ts', content: `import { A } from './a';\nexport const B = A;`, mtimeMs: 100 },
    ];
    const first = buildContext({ files, previous: null, ts: null });
    const second = buildContext({ files, previous: null, ts: null });
    assert.deepEqual(first.apiMap, second.apiMap);
    assert.deepEqual(first.dependencyMap, second.dependencyMap);
    assert.deepEqual(first.symbolIndex, second.symbolIndex);
  });

  test('unchanged mtime reuses cached exports/imports instead of reparsing', () => {
    const files = [
      { localPath: 'src/a.ts', content: `export const A = 1;`, mtimeMs: 100 },
    ];
    const first = buildContext({ files, previous: null, ts: null });
    assert.equal(first.stats.filesParsed, 1);
    assert.equal(first.stats.filesReusedFromCache, 0);

    // Same mtime, content is irrelevant to the cache decision by design —
    // this is what makes it "incremental": no reparse happens on a hit.
    const second = buildContext({ files, previous: first, ts: null });
    assert.equal(second.stats.filesReusedFromCache, 1);
    assert.equal(second.stats.filesParsed, 0);
    assert.deepEqual(second.apiMap, first.apiMap);
  });

  test('a changed mtime forces a reparse of just that file', () => {
    const v1 = [{ localPath: 'src/a.ts', content: `export const A = 1;`, mtimeMs: 100 }];
    const first = buildContext({ files: v1, previous: null, ts: null });

    const v2 = [{ localPath: 'src/a.ts', content: `export const RENAMED = 1;`, mtimeMs: 200 }];
    const second = buildContext({ files: v2, previous: first, ts: null });
    assert.equal(second.stats.filesParsed, 1);
    assert.deepEqual(second.apiMap['src/a.ts'], ['RENAMED']);
  });

  test('a deleted file leaves no stale entries in the aggregated maps', () => {
    const v1 = [
      { localPath: 'src/a.ts', content: `export const A = 1;`, mtimeMs: 100 },
      { localPath: 'src/b.ts', content: `export const B = 2;`, mtimeMs: 100 },
    ];
    const first = buildContext({ files: v1, previous: null, ts: null });
    assert.ok(first.apiMap['src/b.ts']);

    // b.ts removed from disk — only a.ts remains in the current file list.
    const v2 = [{ localPath: 'src/a.ts', content: `export const A = 1;`, mtimeMs: 100 }];
    const second = buildContext({ files: v2, previous: first, ts: null });
    assert.equal(second.apiMap['src/b.ts'], undefined);
    assert.equal(second.symbolIndex.B, undefined);
    assert.equal(second.fileCount, 1);
  });

  test('dependencyMap lists each importer at most once even with duplicate import lines', () => {
    const files = [
      {
        localPath: 'src/a.ts',
        content: `import { x } from './shared';\nimport { y } from './shared';`,
        mtimeMs: 100,
      },
    ];
    const result = buildContext({ files, previous: null, ts: null });
    assert.deepEqual(result.dependencyMap['./shared'], ['src/a.ts']);
  });
});
