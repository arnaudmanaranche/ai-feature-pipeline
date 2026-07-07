// Unit tests for the evaluation harness scorer (eval-pipeline.mjs).
// Run with: npm test
//
// These prove the harness both PASSES a good golden artifact set and FAILS
// a degraded one — otherwise a green eval would mean nothing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runCheck,
  scoreCase,
  loadCases,
  readArtifactFrom,
} from '../skills/afp-pipeline/scripts/eval-pipeline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = resolve(__dirname, '../skills/afp-pipeline/eval');

describe('runCheck — individual rubric checks', () => {
  test('contains / absent', () => {
    assert.equal(runCheck({ type: 'contains', value: 'mermaid' }, 'a mermaid b'), true);
    assert.equal(runCheck({ type: 'contains', value: 'mermaid' }, 'nope'), false);
    assert.equal(runCheck({ type: 'absent', value: 'TBD' }, 'all filled'), true);
    assert.equal(runCheck({ type: 'absent', value: 'TBD' }, 'has TBD here'), false);
  });

  test('section matches a markdown heading at any level', () => {
    assert.equal(runCheck({ type: 'section', value: 'Acceptance criteria' }, '## Acceptance criteria\n'), true);
    assert.equal(runCheck({ type: 'section', value: 'Acceptance criteria' }, '# Acceptance Criteria & notes'), true);
    // The phrase in body text, not a heading, must NOT satisfy a section check.
    assert.equal(runCheck({ type: 'section', value: 'Acceptance criteria' }, 'see the acceptance criteria below'), false);
  });

  test('regex with default case-insensitive flags', () => {
    assert.equal(runCheck({ type: 'regex', value: 'Verdict.*PASS' }, '**Verdict:** PASS'), true);
    assert.equal(runCheck({ type: 'regex', value: 'Verdict.*PASS' }, 'Verdict: FAIL'), false);
  });

  test('unknown check type throws', () => {
    assert.throws(() => runCheck({ type: 'bogus', value: 'x' }, 'y'), /Unknown check type/);
  });
});

describe('scoreCase — aggregate scoring', () => {
  const caseDef = {
    name: 'demo',
    threshold: 1.0,
    checks: [
      { artifact: 'brief.md', type: 'section', value: 'Goals' },
      { artifact: 'plan.md', type: 'contains', value: '```mermaid' },
    ],
  };

  test('all checks pass → score 1.0, passed true', () => {
    const reader = name =>
      name === 'brief.md' ? '## Goals\n' : '```mermaid\nA-->B\n```';
    const r = scoreCase(caseDef, reader);
    assert.equal(r.score, 1);
    assert.equal(r.passed, true);
  });

  test('one failing check drops below threshold → passed false', () => {
    const reader = name => (name === 'brief.md' ? '## Goals\n' : 'no diagram');
    const r = scoreCase(caseDef, reader);
    assert.equal(r.score, 0.5);
    assert.equal(r.passed, false);
  });

  test('a missing artifact fails its checks and is flagged missing', () => {
    const reader = name => (name === 'brief.md' ? '## Goals\n' : null);
    const r = scoreCase(caseDef, reader);
    assert.equal(r.passed, false);
    const planResult = r.results.find(x => x.artifact === 'plan.md');
    assert.equal(planResult.ok, false);
    assert.equal(planResult.missing, true);
  });
});

describe('golden cases — the shipped fixtures actually pass their rubric', () => {
  test('every checked-in case scores at or above its threshold', () => {
    const cases = loadCases(join(EVAL_ROOT, 'cases'));
    assert.ok(cases.length > 0, 'expected at least one golden case');
    for (const caseDef of cases) {
      const baseDir = resolve(EVAL_ROOT, caseDef.artifactsDir);
      const scored = scoreCase(caseDef, readArtifactFrom(baseDir));
      assert.ok(
        scored.passed,
        `${caseDef.name} scored ${scored.score} < ${scored.threshold}: ` +
          scored.results
            .filter(r => !r.ok)
            .map(r => `${r.artifact}:${r.type}:${r.value}`)
            .join(', ')
      );
    }
  });
});
