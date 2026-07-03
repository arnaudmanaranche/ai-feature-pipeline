// Unit tests for the structured-output and permission logic in agent-runner.ts.
// Run with: npm test (node --import tsx --test)
//
// These target the highest-risk part of the pipeline for an autonomous
// multi-agent system: does the same input always produce the same,
// schema-valid, permission-checked output? A model that drifts in phrasing
// must not be able to drift in file-write behavior.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkPermissions,
  getMatchingTypeSkills,
  buildToolSchema,
  buildTool,
  parseToolArgs,
  mockResponse,
  applyChanges,
} from './agent-runner.ts';

describe('buildToolSchema', () => {
  test('only the dev role accepts a files array', () => {
    const devSchema: any = buildToolSchema('dev');
    assert.ok(devSchema.properties.files, 'dev schema must allow files');
    assert.ok(devSchema.required.includes('files'));

    for (const role of ['pm', 'architect', 'review', 'qa', 'retro']) {
      const schema: any = buildToolSchema(role);
      assert.equal(
        schema.properties.files,
        undefined,
        `${role} schema must not allow files`
      );
    }
  });

  test('verdict enum matches the role — no verdict field for roles without one', () => {
    const noVerdictRoles = ['pm', 'architect', 'dev', 'retro'];
    for (const role of noVerdictRoles) {
      const schema: any = buildToolSchema(role);
      assert.equal(schema.properties.verdict, undefined, `${role} should have no verdict field`);
    }

    const expected: Record<string, string[]> = {
      'dev-review': ['clear', 'questions', 'blocked'],
      'pm-respond': ['resolved', 'blocked'],
      review: ['PASS', 'PASS_WITH_NOTES', 'FAIL'],
      qa: ['PASS', 'FAIL', 'BLOCKED_ENV'],
    };
    for (const [role, enumValues] of Object.entries(expected)) {
      const schema: any = buildToolSchema(role);
      assert.deepEqual(schema.properties.verdict.enum, enumValues, role);
      assert.ok(schema.required.includes('verdict'), role);
    }
  });

  test('schema rejects additional properties (forces the model into the exact shape)', () => {
    for (const role of ['pm', 'dev', 'review']) {
      const schema: any = buildToolSchema(role);
      assert.equal(schema.additionalProperties, false, role);
    }
  });

  test('buildTool wraps the schema as a submit_changes function tool', () => {
    const tool: any = buildTool('dev');
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.name, 'submit_changes');
    assert.deepEqual(tool.function.parameters, buildToolSchema('dev'));
  });
});

describe('parseToolArgs', () => {
  test('parses a well-formed submit_changes payload', () => {
    const raw = JSON.stringify({
      files: [{ path: 'a.ts', action: 'modify', content: 'x' }],
      artifacts: [{ path: '.ai/artifacts/features/x/dev-log.md', action: 'create', content: 'log' }],
      verdict: 'PASS',
    });
    const result = parseToolArgs(raw, 'review');
    assert.equal(result.files.length, 1);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.raw, raw);
  });

  test('missing arrays default to empty rather than throwing', () => {
    const result = parseToolArgs(JSON.stringify({ verdict: 'clear' }), 'pm');
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.verdict, 'clear');
  });

  test('non-string verdict is treated as absent, not coerced', () => {
    const result = parseToolArgs(JSON.stringify({ artifacts: [], verdict: 123 }), 'qa');
    assert.equal(result.verdict, '');
  });
});

describe('checkPermissions', () => {
  test('pm cannot write source files even if the model tries', () => {
    const { allowed, blocked } = checkPermissions(
      'pm',
      [{ path: 'src/evil.ts', action: 'create', content: '' }],
      []
    );
    assert.equal(allowed, false);
    assert.equal(blocked.length, 1);
  });

  test('dev can write source files matching allowed extensions', () => {
    const { allowed } = checkPermissions(
      'dev',
      [{ path: 'src/feature.tsx', action: 'modify', content: '' }],
      [{ path: '.ai/artifacts/features/x/dev-log.md', action: 'create', content: '' }]
    );
    assert.equal(allowed, true);
  });

  test('dev cannot write outside the allowed extension set (e.g. a shell script)', () => {
    const { allowed, blocked } = checkPermissions(
      'dev',
      [{ path: 'scripts/deploy.sh', action: 'create', content: '' }],
      []
    );
    assert.equal(allowed, false);
    assert.match(blocked[0], /scripts\/deploy\.sh/);
  });

  test('review cannot write any source files, only .md artifacts', () => {
    const { allowed } = checkPermissions(
      'review',
      [],
      [{ path: '.ai/artifacts/features/x/review-report.md', action: 'create', content: '' }]
    );
    assert.equal(allowed, true);
  });

  test('retro is the only role allowed to write project-memory.md', () => {
    for (const role of ['pm', 'dev', 'review', 'qa']) {
      const { allowed } = checkPermissions(
        role,
        [],
        [{ path: '.ai/project-memory.md', action: 'update', content: '' }]
      );
      assert.equal(allowed, false, role);
    }
    const { allowed } = checkPermissions(
      'retro',
      [],
      [{ path: '.ai/project-memory.md', action: 'update', content: '' }]
    );
    assert.equal(allowed, true);
  });
});

describe('getMatchingTypeSkills', () => {
  test('matches directory-prefixed skills', () => {
    const skills = getMatchingTypeSkills('src/components/Button.tsx', {
      'src/components': 'skills/component-standards.md',
      'src/services': 'skills/service-standards.md',
    });
    assert.deepEqual(skills, ['skills/component-standards.md']);
  });

  test('matches wildcard suffix skills (e.g. *.test.ts)', () => {
    const skills = getMatchingTypeSkills('src/services/api.test.ts', {
      '*.test.ts': 'skills/test-standards.md',
    });
    assert.deepEqual(skills, ['skills/test-standards.md']);
  });

  test('deduplicates when multiple patterns match the same skill', () => {
    const skills = getMatchingTypeSkills('src/components/Button.tsx', {
      'src/components': 'skills/shared.md',
      components: 'skills/shared.md',
    });
    assert.deepEqual(skills, ['skills/shared.md']);
  });
});

describe('mockResponse — dry-run output stability', () => {
  test('is deterministic across repeated calls for the same role/slug', () => {
    const a = mockResponse('pm', 'dark-mode');
    const b = mockResponse('pm', 'dark-mode');
    assert.deepEqual(a, b);
  });

  test('every mocked role produces schema-shaped output (files/artifacts/verdict/raw)', () => {
    for (const role of ['pm', 'dev-review', 'dev', 'review', 'qa', 'retro']) {
      const result: any = mockResponse(role, 'slug');
      assert.ok(Array.isArray(result.files), role);
      assert.ok(Array.isArray(result.artifacts), role);
      assert.equal(typeof result.verdict, 'string', role);
      assert.equal(typeof result.raw, 'string', role);
    }
  });
});

describe('applyChanges — golden write behavior', () => {
  function withTempRoot(fn: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'afp-test-'));
    try {
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('dry-run skips writing source files but still writes artifacts', () => {
    withTempRoot(root => {
      const cwd = process.cwd();
      process.chdir(root);
      try {
        applyChanges(
          'dev',
          [{ path: 'src/feature.ts', action: 'modify', content: 'export const x = 1;\n' }],
          [{ path: '.ai/artifacts/features/x/dev-log.md', action: 'create', content: 'log\n' }],
          'x',
          true
        );
        assert.throws(() => readFileSync(join(root, 'src/feature.ts')));
        const artifact = readFileSync(
          join(root, '.ai/artifacts/features/x/dev-log.md'),
          'utf-8'
        );
        assert.equal(artifact, 'log\n');
      } finally {
        process.chdir(cwd);
      }
    });
  });

  test('a role denied write permission causes applyChanges to exit(1) without writing', () => {
    withTempRoot(root => {
      const cwd = process.cwd();
      process.chdir(root);
      const originalExit = process.exit;
      let exitCode: number | undefined;
      // @ts-expect-error — stub process.exit for the duration of this test
      process.exit = (code?: number) => {
        exitCode = code;
        throw new Error('__exit__');
      };
      try {
        assert.throws(
          () =>
            applyChanges(
              'pm',
              [{ path: 'src/should-not-write.ts', action: 'create', content: 'x' }],
              [],
              'x',
              false
            ),
          /__exit__/
        );
        assert.equal(exitCode, 1);
        assert.throws(() => readFileSync(join(root, 'src/should-not-write.ts')));
      } finally {
        process.exit = originalExit;
        process.chdir(cwd);
      }
    });
  });
});
