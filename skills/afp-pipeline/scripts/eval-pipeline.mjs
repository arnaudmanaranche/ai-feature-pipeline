#!/usr/bin/env node
// Evaluation harness for the AI Feature Pipeline — AI Feature Pipeline module.
//
// The unit tests in test/ prove the *scripts* are correct (schema,
// permissions, dry-run). They say nothing about whether the pipeline
// produces *good features*. This harness closes that gap: it scores a set
// of produced feature artifacts against a rubric, so a prompt edit that
// quietly degrades output quality shows up as a regression instead of being
// discovered in production.
//
// Two layers, both dependency-free:
//   1. Structural scoring (default, free, runs in CI) — deterministic checks
//      over the artifacts: required sections present, mandatory diagram
//      present, no placeholders/TBD, verdict recorded, etc.
//   2. LLM-as-judge (opt-in, --llm-judge) — sends each artifact to the
//      OpenAI-compatible model configured in .ai/config.json for a 1-5
//      rubric score. Skipped gracefully when no config/key is available.
//
// Golden cases live in skills/afp-pipeline/eval/cases/*.json and point at
// checked-in fixture artifacts under skills/afp-pipeline/eval/fixtures/, so
// `npm run eval` is a self-contained regression run. Point --dir at a real
// produced feature directory to score an actual pipeline run.
//
// Usage:
//   node eval-pipeline.mjs                      # score all golden cases
//   node eval-pipeline.mjs --case=<name> --dir=<produced-artifacts-dir>
//   node eval-pipeline.mjs --llm-judge          # also run the LLM judge
//   node eval-pipeline.mjs --cases=<dir>        # override cases directory
//   node eval-pipeline.mjs --case=<name> --dir=<baseline> --compare=<candidate>
//                                               # A/B two runs; exit 1 if the
//                                               # candidate regresses. Prints
//                                               # each side's prompt provenance.
//   node eval-pipeline.mjs --case=<name> --dir=<run> --record=<file> [--label=<s>]
//                                               # append a JSONL history line
//                                               # (score keyed by prompt hash)

import { readFileSync, readdirSync, existsSync, appendFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = resolve(__dirname, '../eval');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Pure scoring (exported for unit tests) ---

// A single rubric check against one artifact's text content.
export function runCheck(check, content) {
  const text = content ?? '';
  switch (check.type) {
    case 'contains':
      return text.includes(check.value);
    case 'absent':
      return !text.includes(check.value);
    case 'section':
      // A markdown heading (any level) whose text includes `value`.
      return new RegExp(`^#{1,6}\\s+.*${escapeRegExp(check.value)}`, 'im').test(
        text
      );
    case 'regex':
      return new RegExp(check.value, check.flags || 'im').test(text);
    default:
      throw new Error(`Unknown check type: ${check.type}`);
  }
}

// Score one case. `readArtifact(name)` returns the artifact's text, or null
// if it doesn't exist. A missing artifact fails every check that references
// it (a case only lists artifacts that are supposed to be there), so a
// pipeline that silently drops an artifact is caught, not scored as absent.
export function scoreCase(caseDef, readArtifact) {
  const results = caseDef.checks.map(c => {
    const content = readArtifact(c.artifact);
    const ok = content == null ? false : runCheck(c, content);
    return {
      artifact: c.artifact,
      type: c.type,
      value: c.value,
      ok,
      missing: content == null,
    };
  });
  const passedCount = results.filter(r => r.ok).length;
  const score = results.length ? passedCount / results.length : 0;
  const threshold =
    typeof caseDef.threshold === 'number' ? caseDef.threshold : 1;
  return {
    name: caseDef.name,
    score,
    threshold,
    passed: score >= threshold,
    results,
  };
}

// Compare a candidate score against a baseline. A change "regresses" if the
// overall score drops OR any individual check that used to pass now fails —
// so a prompt tweak that fixes one thing while quietly breaking another is
// still caught, not hidden by an unchanged net score.
export function compareScores(baseline, candidate) {
  const key = r => `${r.artifact}:${r.type}:${r.value}`;
  const baseMap = new Map(baseline.results.map(r => [key(r), r.ok]));
  const regressions = [];
  const fixes = [];
  for (const r of candidate.results) {
    const before = baseMap.get(key(r));
    if (before === true && !r.ok) regressions.push(key(r));
    if (before === false && r.ok) fixes.push(key(r));
  }
  const delta = candidate.score - baseline.score;
  return {
    scoreBaseline: baseline.score,
    scoreCandidate: candidate.score,
    delta,
    regressions,
    fixes,
    regressed: delta < 0 || regressions.length > 0,
  };
}

// Provenance recorded by agent-runner into a produced feature directory:
// which model + prompt hash produced each role's output. Lets an eval report
// say exactly which prompt version it is scoring. Returns {} for fixture
// directories that have no status files.
export function readProvenance(baseDir) {
  if (!existsSync(baseDir)) return {};
  const prov = {};
  for (const f of readdirSync(baseDir)) {
    const m = f.match(/^\.agent-status-(.+)\.json$/);
    if (!m) continue;
    try {
      const s = JSON.parse(readFileSync(join(baseDir, f), 'utf-8'));
      prov[m[1]] = { model: s.model, promptSha: s.promptSha };
    } catch {
      /* ignore unreadable status file */
    }
  }
  return prov;
}

function formatProvenance(prov) {
  const entries = Object.entries(prov).filter(([, v]) => v.promptSha);
  if (entries.length === 0) return '';
  return entries
    .map(([role, v]) => `${role}@${v.promptSha}`)
    .join(' ');
}

// --- Disk / CLI plumbing ---

function readArtifactFrom(baseDir) {
  return name => {
    const p = join(baseDir, name);
    return existsSync(p) ? readFileSync(p, 'utf-8') : null;
  };
}

function loadCases(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

// Optional LLM-as-judge. Reuses the OpenAI-compatible chat-completions
// config from .ai/config.json (same shape agent-runner uses). Returns null
// — never throws the run — when config or key is unavailable, so the
// structural pass still stands on its own.
async function llmJudge(caseDef, readArtifact) {
  const configPath = join(process.cwd(), '.ai/config.json');
  if (!existsSync(configPath)) {
    console.warn('  (--llm-judge: no .ai/config.json in cwd — skipping)');
    return null;
  }
  let llm;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    llm = cfg.llm || cfg.openRouter;
  } catch {
    return null;
  }
  const apiKey = llm && process.env[llm.apiKeyEnv];
  if (!llm || !apiKey) {
    console.warn(
      '  (--llm-judge: missing llm config or API key env — skipping)'
    );
    return null;
  }
  const artifacts = [...new Set(caseDef.checks.map(c => c.artifact))]
    .map(name => `### ${name}\n\n${readArtifact(name) ?? '(missing)'}`)
    .join('\n\n');
  const prompt = `You are grading the output of an AI feature-development pipeline against this rubric:\n${caseDef.rubric || caseDef.description || caseDef.name}\n\nArtifacts:\n\n${artifacts}\n\nReturn ONLY a JSON object {"score": <1-5 integer>, "reason": "<one sentence>"}.`;
  try {
    const res = await fetch(
      llm.baseUrl || 'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 300,
        }),
      }
    );
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (err) {
    console.warn(`  (--llm-judge: call failed — ${err.message})`);
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const casesDir = args.cases ? resolve(args.cases) : join(EVAL_ROOT, 'cases');
  let cases = loadCases(casesDir);
  if (args.case) cases = cases.filter(c => c.name === args.case);
  if (cases.length === 0) {
    console.error(`No cases found in ${casesDir}`);
    process.exit(1);
  }

  let anyFail = false;
  for (const caseDef of cases) {
    // --dir overrides the case's own fixture directory, so the same rubric
    // can score a real produced feature run.
    const baseDir = args.dir
      ? resolve(args.dir)
      : resolve(EVAL_ROOT, caseDef.artifactsDir);
    const readArtifact = readArtifactFrom(baseDir);
    const scored = scoreCase(caseDef, readArtifact);

    // --- A/B mode: baseline (baseDir) vs candidate (--compare dir) ---
    if (args.compare) {
      const candDir = resolve(args.compare);
      const cand = scoreCase(caseDef, readArtifactFrom(candDir));
      const cmp = compareScores(scored, cand);
      const baseProv = formatProvenance(readProvenance(baseDir));
      const candProv = formatProvenance(readProvenance(candDir));
      const arrow = cmp.delta > 0 ? '▲' : cmp.delta < 0 ? '▼' : '=';
      const mark = cmp.regressed ? '❌ REGRESSED' : '✅ OK';
      console.log(`${mark}  ${caseDef.name}`);
      console.log(
        `        baseline  ${(cmp.scoreBaseline * 100).toFixed(0)}%${baseProv ? `  [${baseProv}]` : ''}`
      );
      console.log(
        `        candidate ${(cmp.scoreCandidate * 100).toFixed(0)}%${candProv ? `  [${candProv}]` : ''}  ${arrow} ${(cmp.delta * 100).toFixed(0)}pt`
      );
      for (const f of cmp.fixes) console.log(`        + fixed:      ${f}`);
      for (const r of cmp.regressions) console.log(`        - regressed:  ${r}`);
      if (cmp.regressed) anyFail = true;
      continue;
    }

    const pct = (scored.score * 100).toFixed(0);
    const mark = scored.passed ? '✅ PASS' : '❌ FAIL';
    const prov = formatProvenance(readProvenance(baseDir));
    console.log(
      `${mark}  ${scored.name}  ${pct}% (threshold ${(scored.threshold * 100).toFixed(0)}%)${prov ? `  [${prov}]` : ''}`
    );
    for (const r of scored.results.filter(r => !r.ok)) {
      console.log(
        `        ✗ ${r.artifact}: ${r.type} "${r.value}"${r.missing ? ' (artifact missing)' : ''}`
      );
    }
    if (args['llm-judge']) {
      const judged = await llmJudge(caseDef, readArtifact);
      if (judged) {
        console.log(`        ⚖  LLM judge: ${judged.score}/5 — ${judged.reason}`);
        if (typeof judged.score === 'number' && judged.score < (caseDef.minJudgeScore ?? 3)) {
          anyFail = true;
        }
      }
    }
    // --record appends a JSONL history line keyed by prompt provenance, so
    // score-over-time per prompt version is queryable.
    if (args.record) {
      const line =
        JSON.stringify({
          ts: new Date().toISOString(),
          case: scored.name,
          score: scored.score,
          passed: scored.passed,
          label: typeof args.label === 'string' ? args.label : undefined,
          provenance: readProvenance(baseDir),
        }) + '\n';
      appendFileSync(resolve(args.record), line);
    }
    if (!scored.passed) anyFail = true;
  }

  console.log('');
  if (anyFail) {
    console.error(args.compare ? 'Candidate regressed vs baseline.' : 'Eval regressions detected.');
    process.exit(1);
  }
  console.log(args.compare ? 'No regressions.' : 'All eval cases passed.');
}

// Run only when invoked directly (not when imported by the test file).
if (process.argv[1] && process.argv[1].endsWith('eval-pipeline.mjs')) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { loadCases, readArtifactFrom };
