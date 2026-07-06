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
  isWithinRoot,
  isOverBudget,
  loadTokenUsage,
  saveTokenUsage,
  validateRegistry,
  REQUIRED_ROLES,
  normalizeArtifactPath,
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
    const result = parseToolArgs(raw, 'review', 'x');
    assert.equal(result.files.length, 1);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.raw, raw);
  });

  test('missing arrays default to empty rather than throwing', () => {
    const result = parseToolArgs(JSON.stringify({ verdict: 'clear' }), 'pm', 'x');
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.verdict, 'clear');
  });

  test('non-string verdict is treated as absent, not coerced', () => {
    const result = parseToolArgs(JSON.stringify({ artifacts: [], verdict: 123 }), 'qa', 'x');
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

  test('path traversal is blocked even when the extension matches an allowed pattern', () => {
    // `../../../../tmp/pwned.ts` ends in `.ts`, which the dev role's
    // allowedFiles regex happily matches on the string alone — this is
    // exactly why containment has to be checked independently of the
    // extension/pattern regexes, not folded into them.
    const { allowed, blocked } = checkPermissions(
      'dev',
      [{ path: '../../../../tmp/pwned.ts', action: 'create', content: 'evil' }],
      []
    );
    assert.equal(allowed, false);
    assert.match(blocked[0], /escapes project root/);
  });

  test('path traversal in an artifact path is blocked the same way', () => {
    // The artifact regex only checks that ".ai/artifacts/...md" appears
    // somewhere in the string — .test() is unanchored, so a leading `../`
    // sequence in front of a legitimate-looking suffix still matches it.
    const { allowed, blocked } = checkPermissions(
      'pm',
      [],
      [{ path: '../../.ai/artifacts/features/x/evil.md', action: 'create', content: '' }]
    );
    assert.equal(allowed, false);
    assert.match(blocked[0], /escapes project root/);
  });

  test('a role with no PERMISSIONS entry still gets path containment enforced', () => {
    const { allowed, blocked } = checkPermissions(
      'some-future-role-not-yet-in-PERMISSIONS',
      [{ path: '../../../../tmp/pwned.ts', action: 'create', content: '' }],
      []
    );
    assert.equal(allowed, false);
    assert.match(blocked[0], /escapes project root/);
  });
});

describe('isWithinRoot', () => {
  test('a normal relative path resolves inside root', () => {
    assert.equal(isWithinRoot('src/feature.ts'), true);
    assert.equal(isWithinRoot('.ai/artifacts/features/x/dev-log.md'), true);
  });

  test('a traversal path that escapes the process root is rejected', () => {
    assert.equal(isWithinRoot('../../../../tmp/pwned.ts'), false);
    assert.equal(isWithinRoot('../../etc/passwd'), false);
  });

  test('an absolute path outside root is rejected', () => {
    assert.equal(isWithinRoot('/etc/passwd'), false);
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

  test('a path-traversal attempt is refused end-to-end — nothing is written outside root', () => {
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
      // Sibling of `root` (both live under the same mkdtemp parent), i.e.
      // exactly where `../escape.ts` would land if containment failed.
      const escapeTarget = join(root, '..', 'afp-traversal-escape.ts');
      try {
        assert.throws(
          () =>
            applyChanges(
              'dev',
              [{ path: '../afp-traversal-escape.ts', action: 'create', content: 'evil' }],
              [],
              'x',
              false
            ),
          /__exit__/
        );
        assert.equal(exitCode, 1);
        assert.throws(() => readFileSync(escapeTarget));
      } finally {
        process.exit = originalExit;
        process.chdir(cwd);
        rmSync(escapeTarget, { force: true });
      }
    });
  });
});

describe('isOverBudget — token spend circuit breaker', () => {
  test('no budget configured means never over budget', () => {
    assert.equal(isOverBudget({ totalTokens: 999_999_999, calls: [] }, undefined), false);
    assert.equal(isOverBudget({ totalTokens: 999_999_999, calls: [] }, 0), false);
  });

  test('under budget is not blocked', () => {
    assert.equal(isOverBudget({ totalTokens: 100, calls: [] }, 1000), false);
  });

  test('at or over budget is blocked', () => {
    assert.equal(isOverBudget({ totalTokens: 1000, calls: [] }, 1000), true);
    assert.equal(isOverBudget({ totalTokens: 1500, calls: [] }, 1000), true);
  });
});

describe('loadTokenUsage / saveTokenUsage — disk round-trip', () => {
  test('missing usage file defaults to zero, and a saved value round-trips', () => {
    const root = mkdtempSync(join(tmpdir(), 'afp-test-'));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const featureDir = '.ai/artifacts/features/x';
      const initial = loadTokenUsage(featureDir);
      assert.deepEqual(initial, { totalTokens: 0, calls: [] });

      initial.totalTokens += 500;
      initial.calls.push({ role: 'pm', tokens: 500 });
      saveTokenUsage(featureDir, initial);

      const reloaded = loadTokenUsage(featureDir);
      assert.deepEqual(reloaded, { totalTokens: 500, calls: [{ role: 'pm', tokens: 500 }] });
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('validateRegistry — .ai/agents.json schema validation', () => {
  function validRoles() {
    const role = () => ({ skill: 's.md', model: 'm', artifact: 'a.md', description: 'd', maxTokens: 1000 });
    const roles: Record<string, unknown> = {};
    for (const name of REQUIRED_ROLES) roles[name] = role();
    return roles;
  }

  function runWithStubbedExit(fn: () => void): { exitCode: number | undefined; errors: string[] } {
    const originalExit = process.exit;
    const originalError = console.error;
    const errors: string[] = [];
    let exitCode: number | undefined;
    // @ts-expect-error — stub for the duration of this test
    process.exit = (code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.join(' '));
    };
    try {
      fn();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== '__exit__') throw e;
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
    return { exitCode, errors };
  }

  test('a complete, well-formed registry passes through unchanged', () => {
    const roles = validRoles();
    const result = validateRegistry({ roles }, '.ai/agents.json');
    assert.deepEqual(Object.keys(result).sort(), REQUIRED_ROLES.slice().sort());
  });

  test('a missing required role is rejected with its name in the error', () => {
    const roles = validRoles();
    delete roles['memory-compact'];
    const { exitCode, errors } = runWithStubbedExit(() =>
      validateRegistry({ roles }, '.ai/agents.json')
    );
    assert.equal(exitCode, 1);
    assert.ok(errors.some(e => e.includes('memory-compact')), errors.join('\n'));
  });

  test('a role missing a required field is rejected', () => {
    const roles = validRoles();
    (roles.dev as any).model = '';
    const { exitCode, errors } = runWithStubbedExit(() =>
      validateRegistry({ roles }, '.ai/agents.json')
    );
    assert.equal(exitCode, 1);
    assert.ok(errors.some(e => e.includes('roles.dev.model')), errors.join('\n'));
  });

  test('a non-positive maxTokens is rejected', () => {
    const roles = validRoles();
    (roles.pm as any).maxTokens = 0;
    const { exitCode, errors } = runWithStubbedExit(() =>
      validateRegistry({ roles }, '.ai/agents.json')
    );
    assert.equal(exitCode, 1);
    assert.ok(errors.some(e => e.includes('roles.pm.maxTokens')), errors.join('\n'));
  });

  test('a missing "roles" object entirely is rejected', () => {
    const { exitCode } = runWithStubbedExit(() =>
      validateRegistry({}, '.ai/agents.json')
    );
    assert.equal(exitCode, 1);
  });
});

describe('normalizeArtifactPath — model-returned bare filenames', () => {
  test('a bare filename gets prefixed with the feature artifact directory', () => {
    // Found live: PM's task instructions spell out the full path, but the
    // schema only describes the convention in prose — a real model still
    // submitted "feature-brief.md" instead of the full path.
    assert.equal(
      normalizeArtifactPath('feature-brief.md', 'monthly-size-reminder'),
      '.ai/artifacts/features/monthly-size-reminder/feature-brief.md'
    );
  });

  test('a path already under .ai/ is left untouched', () => {
    assert.equal(
      normalizeArtifactPath('.ai/artifacts/features/x/dev-log.md', 'x'),
      '.ai/artifacts/features/x/dev-log.md'
    );
    assert.equal(normalizeArtifactPath('.ai/project-memory.md', 'x'), '.ai/project-memory.md');
  });

  test('a "<slug>/filename" path (no .ai/artifacts/features/ prefix) is not double-nested', () => {
    // Found live, one call after the bare-filename case: the same role
    // returned a different partial form of the path on a different run —
    // "monthly-size-reminder-notification/feature-brief.md". The old
    // (bare-filename-only) fix re-prefixed the whole thing and produced
    // .ai/artifacts/features/<slug>/<slug>/feature-brief.md — a duplicate
    // nested path that left the real content somewhere dev-review never
    // looked, while the placeholder stub at the expected path stayed empty.
    assert.equal(
      normalizeArtifactPath('monthly-size-reminder-notification/feature-brief.md', 'monthly-size-reminder-notification'),
      '.ai/artifacts/features/monthly-size-reminder-notification/feature-brief.md'
    );
  });

  test('a path with "artifacts/features/<slug>/" but missing the leading ".ai/" is fixed, not doubled', () => {
    assert.equal(
      normalizeArtifactPath('artifacts/features/x/dev-log.md', 'x'),
      '.ai/artifacts/features/x/dev-log.md'
    );
  });
});

describe('parseToolArgs — end-to-end path normalization', () => {
  test('an artifact submitted with a bare filename is written to the feature directory, not blocked', () => {
    const raw = JSON.stringify({
      artifacts: [{ path: 'feature-brief.md', action: 'update', content: 'brief' }],
      verdict: 'clear',
    });
    const result = parseToolArgs(raw, 'pm', 'monthly-size-reminder');
    assert.equal(result.artifacts[0].path, '.ai/artifacts/features/monthly-size-reminder/feature-brief.md');
    const { allowed } = checkPermissions('pm', [], result.artifacts);
    assert.equal(allowed, true);
  });
});
