#!/usr/bin/env npx tsx
// Multi-agent orchestration via any OpenAI-compatible chat-completions API
// (OpenRouter by default) — AI Feature Pipeline module
// Usage: node scripts/agent-runner.ts --role=<role> --slug=<slug> [--project-root=<path>]
// Requires: OPENROUTER_API_KEY env var, or whatever key is set at llm.apiKeyEnv
// in .ai/config.json for a non-OpenRouter provider

// dotenv is optional — load via dynamic import so the script works without it
import { execSync, execFileSync } from 'child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';

// Project root: default to cwd, override with --project-root.
// Resolved lazily (not cached) so tests can chdir() into a fixture root.
function getRoot(): string {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--project-root=(.+)$/);
    if (m) return m[1];
  }
  return process.cwd();
}

// Every file/artifact path in a model's structured output is untrusted
// input. `join(root, path)` alone does NOT stop `path` from containing
// `../` segments that resolve outside root — this is the actual containment
// check, used by read()/write() and by checkPermissions() before anything
// touches disk.
function isWithinRoot(candidatePath: string): boolean {
  const root = resolve(getRoot());
  const target = resolve(getRoot(), candidatePath);
  return target === root || target.startsWith(root + sep);
}

// --- Project config ---

interface ProjectConfig {
  project: {
    name: string;
    appId: string;
    githubRepo: string;
    branchPrefix: string;
    defaultBranch: string;
    pathAlias: string;
    // Opt-in circuit breaker on total OpenRouter token spend per feature.
    // Undefined or 0 means unlimited (the pre-existing behavior).
    maxTokensPerFeature?: number;
  };
  bot: { name: string; email: string };
  commands: {
    packageManager: string;
    runScript: string;
    typecheck: string;
    lint: string;
    test?: string;
    formatCheck: string;
    formatWrite: string;
  };
  stack: {
    router: string;
    styling: string;
    backend: string;
    errorTracking: string;
    analytics: {
      provider: string;
      package: string;
      hook: string;
      file: string;
    };
    paywall: {
      provider: string;
      package: string;
      product: string;
      context: string;
      screen: string;
    };
    locales: string[];
    localeDir: string;
  };
  e2e: { framework: string; dir: string };
  // Generic OpenAI-compatible chat-completions + tool-calling config.
  // Covers OpenRouter, OpenAI, Azure OpenAI, Groq, Together, Fireworks, and
  // Ollama (local) unchanged — they all speak the same request/response
  // shape. `baseUrl` defaults to OpenRouter's for backward compatibility;
  // point it elsewhere to swap providers without touching the call site.
  llm: {
    // 'claude-cli' shells out to the Claude Code CLI itself (`claude -p`)
    // instead of hitting an HTTP endpoint — for users whose only credential
    // is a Claude subscription (via `claude setup-token`), no API key.
    // Defaults to 'openai-compatible' for back-compat with existing configs.
    backend?: 'openai-compatible' | 'claude-cli';
    baseUrl: string;
    // Not read/required when backend is 'claude-cli'.
    apiKeyEnv: string;
    model: string;
    refererUrl: string;
    // OpenRouter provider-routing preferences, passed through verbatim.
    // Optional — omitted from the request entirely when not configured.
    // Added after a real project's Architect calls consistently hit a
    // 504 "Upstream idle timeout exceeded" from Amazon Bedrock (one of
    // OpenRouter's upstream providers for this model) on large prompts;
    // `ignore` lets a project route around a specific upstream that's
    // proving unreliable for it. Only meaningful when `baseUrl` is
    // OpenRouter's — harmless to omit for other providers.
    provider?: {
      order?: string[];
      ignore?: string[];
      allow_fallbacks?: boolean;
    };
    // Per-call spend cap in USD, passed to `claude -p --max-budget-usd`.
    // Only meaningful when backend is 'claude-cli'.
    maxBudgetUsd?: number;
  };
  sourceDirs: string[];
  skipDirs: string[];
  providerNesting: string[];
}

const DEFAULT_LLM_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

function loadProjectConfig(): ProjectConfig {
  const configPath = join(getRoot(), '.ai/config.json');
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    // Back-compat: older .ai/config.json files use the pre-abstraction
    // `openRouter` key instead of `llm`. Alias it rather than breaking
    // every existing install on upgrade.
    if (!parsed.llm && parsed.openRouter) {
      parsed.llm = parsed.openRouter;
    }
    if (parsed.llm && !parsed.llm.baseUrl) {
      parsed.llm.baseUrl = DEFAULT_LLM_BASE_URL;
    }
    return parsed;
  } catch {
    console.warn(
      `  Warning: config.json not found at ${configPath}, using defaults`
    );
    return {
      project: {
        name: 'My Project',
        appId: 'com.example.app',
        githubRepo: 'org/repo',
        branchPrefix: 'feat',
        defaultBranch: 'main',
        pathAlias: '@',
      },
      bot: { name: 'agent[bot]', email: 'agent@project.dev' },
      commands: {
        packageManager: 'npm',
        runScript: 'tsx',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        formatCheck: 'prettier --check .',
        formatWrite: 'prettier --write .',
      },
      stack: {
        router: 'react-router',
        styling: 'CSS',
        backend: '',
        errorTracking: '',
        analytics: { provider: '', package: '', hook: '', file: '' },
        paywall: {
          provider: '',
          package: '',
          product: '',
          context: '',
          screen: '',
        },
        locales: ['en'],
        localeDir: 'i18n/locales',
      },
      e2e: { framework: '', dir: 'e2e' },
      llm: {
        baseUrl: DEFAULT_LLM_BASE_URL,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        model: 'openai/gpt-4o',
        refererUrl: 'https://github.com/org/repo',
      },
      sourceDirs: ['src'],
      skipDirs: ['node_modules', 'dist', 'build'],
      providerNesting: [],
    };
  }
}

const CONFIG = loadProjectConfig();

// --- Config (loaded from .ai/agents.json) ---

interface RoleConfig {
  skill: string;
  model: string;
  artifact: string;
  description: string;
  maxTokens: number;
  typeSkills?: Record<string, string>;
  extraSkills?: string[];
}

// Every one of these MUST have an entry in .ai/agents.json — agent-runner.ts
// hardcodes behavior (permissions, output schema, task instructions) by
// these exact role names elsewhere in this file. A missing or malformed
// role previously only surfaced as "Unknown role: X" whenever the pipeline
// happened to reach that stage — often several stages and OpenRouter calls
// into a run. Validating the whole registry up front fails on the very
// first invocation instead.
const REQUIRED_ROLES = [
  'pm',
  'dev-review',
  'pm-respond',
  'architect',
  'dev',
  'review',
  'qa',
  'retro',
  'memory-compact',
];

function validateRegistry(
  data: unknown,
  registryPath: string
): Record<string, RoleConfig> {
  const roles = (data as { roles?: unknown } | null)?.roles;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
    console.error(`Invalid ${registryPath}: missing a "roles" object.`);
    process.exit(1);
  }

  const rolesObj = roles as Record<string, unknown>;
  const missingRoles = REQUIRED_ROLES.filter(r => !rolesObj[r]);
  if (missingRoles.length > 0) {
    console.error(
      `Invalid ${registryPath}: missing required role(s): ${missingRoles.join(', ')}.`
    );
    console.error(
      `See "Required roles" in skills/afp-setup/SKILL.md for what each role entry needs.`
    );
    process.exit(1);
  }

  const fieldErrors: string[] = [];
  for (const [name, cfgRaw] of Object.entries(rolesObj)) {
    const cfg = cfgRaw as Record<string, unknown>;
    for (const field of ['skill', 'model', 'artifact', 'description'] as const) {
      if (typeof cfg?.[field] !== 'string' || cfg[field] === '') {
        fieldErrors.push(`roles.${name}.${field} must be a non-empty string`);
      }
    }
    if (typeof cfg?.maxTokens !== 'number' || cfg.maxTokens <= 0) {
      fieldErrors.push(`roles.${name}.maxTokens must be a positive number`);
    }
  }
  if (fieldErrors.length > 0) {
    console.error(`Invalid ${registryPath}:`);
    for (const e of fieldErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  return rolesObj as unknown as Record<string, RoleConfig>;
}

function loadRegistry(): Record<string, RoleConfig> {
  const registryPath = join(getRoot(), '.ai/agents.json');
  let raw: string;
  try {
    raw = readFileSync(registryPath, 'utf-8');
  } catch (err) {
    console.error(`Failed to load registry from ${registryPath}: ${err}`);
    process.exit(1);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Invalid JSON in ${registryPath}: ${err}`);
    process.exit(1);
  }
  return validateRegistry(data, registryPath);
}

// Lazy — loadRegistry() exits the process if .ai/agents.json is missing,
// which must not happen just from importing this module (e.g. in tests).
let _roles: Record<string, RoleConfig> | null = null;
function getRoles(): Record<string, RoleConfig> {
  if (!_roles) _roles = loadRegistry();
  return _roles;
}

// --- Utils ---

function parseArgs() {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([\w-]+)=(.+)$/);
    if (match) args[match[1]] = match[2];
    else if (arg === '--dry-run') args['dry-run'] = 'true';
    else if (arg === '--list-roles') args['list-roles'] = 'true';
  }

  if (args['list-roles']) {
    console.log('Available roles:');
    for (const [name, config] of Object.entries(getRoles())) {
      console.log(`  ${name} — ${config.description} (${config.model})`);
    }
    process.exit(0);
  }

  if (!args.role || !args.slug) {
    const validRoles = Object.keys(getRoles()).join('|');
    console.error(
      `Usage: node scripts/agent-runner.ts --role=<${validRoles}> --slug=<feature-slug> [--project-root=<path>] [--dry-run] [--list-roles]`
    );
    process.exit(1);
  }
  if (!getRoles()[args.role]) {
    console.error(
      `Unknown role: ${args.role}. Valid: ${Object.keys(getRoles()).join(', ')}`
    );
    process.exit(1);
  }
  return args;
}

function read(path: string): string {
  if (!isWithinRoot(path)) {
    return `[file not found: ${path}]`;
  }
  const fullPath = join(getRoot(), path);
  try {
    return readFileSync(fullPath, 'utf-8');
  } catch {
    return `[file not found: ${path}]`;
  }
}

function write(path: string, content: string) {
  if (!isWithinRoot(path)) {
    console.error(`❌ Refusing to write outside project root: ${path}`);
    process.exit(1);
  }
  const fullPath = join(getRoot(), path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  console.log(`  ✍️  ${path}`);
}

function fileTree(dir: string, prefix = ''): string {
  const fullPath = join(getRoot(), dir);
  try {
    const entries = readdirSync(fullPath, { withFileTypes: true });
    const lines: string[] = [];
    // Use project-configured skipDirs so the tree is stack-agnostic.
    // Falls back to sensible defaults if config is unavailable.
    const SKIP_DIRS = new Set(
      CONFIG.skipDirs?.length
        ? CONFIG.skipDirs
        : ['node_modules', 'dist', 'build']
    );
    const filtered = entries.filter(
      e => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)
    );
    for (const entry of filtered) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        lines.push(fileTree(rel, prefix + '  '));
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }
    return lines.filter(l => l.trim()).join('\n');
  } catch {
    return '';
  }
}

// --- Context loading ---

function loadContext(role: string, slug: string) {
  const featureDir = `.ai/artifacts/features/${slug}`;
  const briefPath = `${featureDir}/feature-brief.md`;
  const devLogPath = `${featureDir}/dev-log.md`;

  const threadPath = `${featureDir}/pm-dev-thread.md`;
  const issueBodyPath = `${featureDir}/issue-body.md`;
  const brief = existsSync(join(getRoot(), briefPath)) ? read(briefPath) : null;
  const devLog = existsSync(join(getRoot(), devLogPath)) ? read(devLogPath) : null;
  const pmDevThread = existsSync(join(getRoot(), threadPath))
    ? read(threadPath)
    : null;
  const issueBody = existsSync(join(getRoot(), issueBodyPath))
    ? read(issueBodyPath)
    : null;
  const governance = read('.ai/GOVERNANCE.md');
  const denied = read('.ai/DENIED_ACTIONS.md');
  const projectContext = read('.ai/project-context.md');
  const registryAnalytics = read('.ai/registry/analytics-events.md');
  const registryPaywall = read('.ai/registry/paywall-touchpoints.md');
  const registryShip = read('.ai/registry/ship-checklist.md');
  const registryScope = read('.ai/registry/scope-checklist.md');

  return {
    featureDir,
    brief,
    devLog,
    pmDevThread,
    issueBody,
    governance,
    denied,
    projectContext,
    registryAnalytics,
    registryPaywall,
    registryShip,
    registryScope,
  };
}

// --- Type-skill matching ---

function getMatchingTypeSkills(
  filePath: string,
  typeSkills: Record<string, string>
): string[] {
  const skills: string[] = [];
  for (const [dir, skill] of Object.entries(typeSkills)) {
    if (dir.startsWith('*')) {
      if (filePath.endsWith(dir.slice(1))) {
        skills.push(skill);
      }
    } else if (filePath.startsWith(dir) || filePath.includes('/' + dir)) {
      skills.push(skill);
    }
  }
  return [...new Set(skills)];
}

// --- Prompt building ---

function buildSystemPrompt(role: string, skillContent: string) {
  const isQa = role === 'qa';
  const isDevReview = role === 'dev-review';
  const isPmRespond = role === 'pm-respond';

  const guidance = [
    isQa
      ? `For QA: if E2E results are provided in the context (from this project's own CI, for whatever framework it configured), use them to determine PASS/FAIL. If no results are available and you cannot run the E2E suite locally, use BLOCKED_ENV and note why — do not fabricate results.`
      : '',
    isDevReview
      ? `Guidelines:
- Only mark **blocked** if the spec is genuinely ambiguous (unclear WHAT to build, not HOW).
- For technical edge cases (timezones, scheduling, permission flows), assume the Dev can figure it out — mark **clear** unless the brief is truly missing.
- If you have minor questions, mark **clear** and add them as resolved threads in pm-dev-thread.md.
- Do NOT ask the same questions again if they've already been answered in a previous thread.

If **blocked**, submit a \`blocker.md\` artifact with the **"What we do not know"** section filled in. Do NOT leave placeholder sections empty. If **questions**, submit an updated \`pm-dev-thread.md\` artifact with each question added as a thread entry. If **clear**, submit an empty artifacts list.`
      : '',
    isPmRespond
      ? `Read the open threads in \`pm-dev-thread.md\`. Answer each question, update \`feature-brief.md\` if needed, then mark threads **Resolved** in the submitted artifact. If you cannot resolve a thread, set status to **blocked** and submit a \`blocker.md\` artifact.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return `You are the **${role.toUpperCase()}** agent. Follow the governance rules and context files for project-specific rules.

${skillContent}

${guidance}

You MUST respond by calling the \`submit_changes\` tool exactly once with your complete output — do not respond with plain text, explanations, or markdown outside the tool call. Every file and artifact you submit must contain its COMPLETE content: no placeholders, no partial snippets, no "// ... rest stays the same". The script writes files and artifacts exactly as you provide them.`;
}

// File-extension conventions per E2E framework, used only to filter the
// "Existing E2E flows" listing shown to QA. An unrecognized/custom
// framework name just lists every file in e2e.dir (empty pattern list).
const E2E_FLOW_PATTERNS: Record<string, string[]> = {
  maestro: ['.yaml', '.yml'],
  playwright: ['.spec.ts', '.spec.js', '.test.ts', '.test.js'],
  cypress: ['.cy.ts', '.cy.js'],
  detox: ['.e2e.ts', '.e2e.js'],
  webdriverio: ['.e2e.ts', '.e2e.js'],
};

// perFileExports/perFileImports/fileFingerprints/stats exist purely to
// support rebuild-context.mjs's own incremental cache between runs — the
// model never needs them, and on a real ~46-file project they added ~16KB
// (roughly a third) of the Architect's prompt for zero architectural
// value. Found live: a large combined prompt (this + directory tree +
// templates + a detailed feature brief) pushed past ~90k chars and
// triggered a genuine upstream provider timeout (OpenRouter -> Bedrock,
// 504 "Upstream idle timeout exceeded") on every attempt — not something a
// retry could fix, since the cause doesn't change between attempts.
function trimContextForPrompt(ctxData: string): string {
  try {
    const parsed = JSON.parse(ctxData);
    delete parsed.perFileExports;
    delete parsed.perFileImports;
    delete parsed.fileFingerprints;
    delete parsed.stats;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return ctxData; // malformed JSON — send as-is rather than fail
  }
}

function buildUserPrompt(
  role: string,
  slug: string,
  ctx: ReturnType<typeof loadContext>,
  config: RoleConfig
) {
  const sections: string[] = [];

  // Context header
  sections.push(
    `# Task: Run ${role.toUpperCase()} agent for feature \`${slug}\``
  );

  // Feature brief
  if (ctx.brief) {
    sections.push(`## Feature brief\n\n\`\`\`markdown\n${ctx.brief}\n\`\`\``);
  } else {
    sections.push(`## Feature brief\n\nNo feature brief yet. Create one.`);
  }

  // Dev log (for review/qa/retro)
  if (
    ctx.devLog &&
    role !== 'pm' &&
    role !== 'pm-respond' &&
    role !== 'dev-review'
  ) {
    sections.push(`## Dev log\n\n\`\`\`markdown\n${ctx.devLog}\n\`\`\``);
  }

  // PM ↔ Dev thread (for dev-review, pm-respond, retro)
  if (
    ctx.pmDevThread &&
    (role === 'dev-review' || role === 'pm-respond' || role === 'retro')
  ) {
    sections.push(
      `## PM ↔ Dev thread\n\n\`\`\`markdown\n${ctx.pmDevThread}\n\`\`\``
    );
  }

  // Issue body (for PM and dev-review — original GitHub issue content)
  if (ctx.issueBody && (role === 'pm' || role === 'dev-review')) {
    sections.push(
      `## Original GitHub issue\n\n\`\`\`markdown\n${ctx.issueBody}\n\`\`\``
    );
  }

  // Retro gets all artifacts from the feature folder
  if (role === 'retro') {
    const extraArtifacts = [
      'technical-plan.md',
      'repository-context.md',
      'review-report.md',
      'qa-report.md',
      'blocker.md',
    ];
    for (const art of extraArtifacts) {
      const content = read(`${ctx.featureDir}/${art}`);
      if (content && !content.startsWith('[file not found')) {
        sections.push(`## ${art}\n\n\`\`\`markdown\n${content}\n\`\`\``);
      }
    }
    // Also load agent response logs
    const agentResponseDir = join(getRoot(), ctx.featureDir);
    if (existsSync(agentResponseDir)) {
      const entries = readdirSync(agentResponseDir);
      const responseLogs = entries.filter(
        e => e.startsWith('.agent-') && e.endsWith('-response.md')
      );
      for (const log of responseLogs) {
        const content = read(`${ctx.featureDir}/${log}`);
        if (content && !content.startsWith('[file not found')) {
          sections.push(
            `## ${log}\n\n\`\`\`markdown\n${content.slice(0, 3000)}\n\`\`\``
          );
        }
      }
    }
  }

  // Governance
  sections.push(`## Governance\n\n\`\`\`markdown\n${ctx.governance}\n\`\`\``);

  // Project context (all agents)
  if (ctx.projectContext) {
    sections.push(
      `## Project context\n\n\`\`\`markdown\n${ctx.projectContext}\n\`\`\``
    );
  }

  // Denied actions
  sections.push(`## Denied actions\n\n\`\`\`markdown\n${ctx.denied}\n\`\`\``);

  // Registries
  sections.push(
    `## Registry: Analytics\n\n\`\`\`markdown\n${ctx.registryAnalytics}\n\`\`\``
  );
  sections.push(
    `## Registry: Paywall\n\n\`\`\`markdown\n${ctx.registryPaywall}\n\`\`\``
  );
  sections.push(
    `## Registry: Ship checklist\n\n\`\`\`markdown\n${ctx.registryShip}\n\`\`\``
  );
  sections.push(
    `## Registry: Scope checklist\n\n\`\`\`markdown\n${ctx.registryScope}\n\`\`\``
  );

  // Cross-session project memory — every role gets this, not just PM/Architect/
  // Retro. A pitfall or convention Retro recorded after a past feature is
  // just as relevant to Dev Review or QA as it is to PM/Architect.
  const memory = read('.ai/project-memory.md');
  if (memory && !memory.startsWith('[file not found')) {
    sections.push(
      `## Project memory (cross-session)\n\n\`\`\`markdown\n${memory}\n\`\`\``
    );
  }

  // For PM, Dev, or Architect: add directory tree for context
  if (role === 'pm' || role === 'dev' || role === 'architect') {
    sections.push(
      `## Project directory tree\n\n\`\`\`\n${fileTree('.')}\n\`\`\``
    );
  }

  // Architect-specific: architecture maps and templates
  if (role === 'architect') {
    const ctxData = read('.ai/context.json');
    if (ctxData && !ctxData.startsWith('[file not found')) {
      sections.push(
        `## Architecture maps\n\n\`\`\`json\n${trimContextForPrompt(ctxData)}\n\`\`\``
      );
    }
    const techTmpl = read('skills/afp-pipeline/templates/technical-plan.md');
    if (techTmpl && !techTmpl.startsWith('[file not found')) {
      sections.push(
        `## Technical plan template\n\n\`\`\`markdown\n${techTmpl}\n\`\`\``
      );
    }
    const repoCmpl = read('skills/afp-pipeline/templates/repository-context.md');
    if (repoCmpl && !repoCmpl.startsWith('[file not found')) {
      sections.push(
        `## Repository context template\n\n\`\`\`markdown\n${repoCmpl}\n\`\`\``
      );
    }
  }

  // Extra skills + type-specific skills (Dev only)
  if (role === 'dev') {
    // Load extra skills from registry
    if (config.extraSkills) {
      for (const skillPath of config.extraSkills) {
        if (existsSync(join(getRoot(), skillPath))) {
          const skillName =
            skillPath.split('/').pop()?.replace('.md', '') ?? 'standards';
          sections.push(
            `## ${skillName} (cross-cutting)\n\n\`\`\`markdown\n${read(skillPath)}\n\`\`\``
          );
        }
      }
    }
    // Dev also gets the Architect's technical plan and repository context
    const techPlan = read(`${ctx.featureDir}/technical-plan.md`);
    if (techPlan && !techPlan.startsWith('[file not found')) {
      sections.push(
        `## Technical plan (Architect)\n\n\`\`\`markdown\n${techPlan}\n\`\`\``
      );
    }
    const repoContext = read(`${ctx.featureDir}/repository-context.md`);
    if (repoContext && !repoContext.startsWith('[file not found')) {
      sections.push(
        `## Repository context (Architect)\n\n\`\`\`markdown\n${repoContext}\n\`\`\``
      );
    }
    // Inject existing file contents for files listed in the tech plan
    // so the Dev sees real code instead of hallucinating replacements
    const impactedFilePaths: string[] = [];
    if (techPlan) {
      // Extract file paths from the tech plan. Matches backtick-quoted paths
      // anywhere on a line (not just at line start) to handle varied formatting:
      //   - `path/to/file.ts` — description
      //   **`path/to/file.ts`** — description
      //   - path/to/file.ts — description (no backticks, fallback)
      const fileRefPattern = /`([a-zA-Z0-9_./@()/-]+\.(?:ts|tsx|js|jsx|css|json|yaml|yml|md))`/g;
      const fileRefSet = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = fileRefPattern.exec(techPlan)) !== null) {
        const p = m[1];
        // Skip template paths and .ai artifact paths — those are not source files
        if (!p.startsWith('.ai/') && !p.includes('{')) fileRefSet.add(p);
      }
      const fileRefs = fileRefSet.size > 0 ? [...fileRefSet] : null;
      if (fileRefs) {
        const seen = new Set<string>();
        sections.push(
          `\n## Existing files to modify\n\nBelow is the current content of each existing file you need to modify. Read them carefully — YOUR OUTPUT WILL REPLACE THE ENTIRE FILE, so you must preserve existing functionality and only add/change what's needed.\n`
        );
        for (const ref of fileRefs) {
          const filePath = ref;
          if (!filePath || seen.has(filePath)) continue;
          seen.add(filePath);
          impactedFilePaths.push(filePath);
          const content = read(filePath);
          if (content && !content.startsWith('[file not found')) {
            const ext = filePath.endsWith('.json') ? 'json' : 'tsx';
            sections.push(
              `### \`${filePath}\`\n\n\`\`\`${ext}\n${content}\n\`\`\``
            );
          }
        }
      }
    }
    // Inject file-type-specific skills based on impacted files
    if (impactedFilePaths.length > 0 && config.typeSkills) {
      const skillSet = new Set<string>();
      for (const fp of impactedFilePaths) {
        getMatchingTypeSkills(fp, config.typeSkills).forEach(s =>
          skillSet.add(s)
        );
      }
      if (skillSet.size > 0) {
        sections.push(
          `\n## File-type-specific standards\n\nBelow are the coding standards for the file types you're modifying. Apply ALL matching sections.\n`
        );
        for (const skill of skillSet) {
          const content = read(skill);
          if (content && !content.startsWith('[file not found')) {
            sections.push(
              `### ${skill.split('/').pop()?.replace('.md', '') ?? 'standards'}\n\n\`\`\`markdown\n${content}\n\`\`\``
            );
          }
        }
      }
    }
    // Quality gate feedback (for Dev retry on typecheck/lint/test failure —
    // the file may contain any combination of the three, see run_quality_gates
    // in run-pipeline.sh)
    const typecheckFeedback = read(
      `${ctx.featureDir}/.agent-typecheck-feedback.md`
    );
    if (typecheckFeedback && !typecheckFeedback.startsWith('[file not found')) {
      sections.push(
        `\n## Quality gate failures (previous attempt)\n\nFix ALL of the following:\n\`\`\`\n${typecheckFeedback}\n\`\`\``
      );
    }

    // Review feedback (for Dev retry after a Review FAIL verdict)
    const reviewFeedback = read(`${ctx.featureDir}/.agent-review-feedback.md`);
    if (reviewFeedback && !reviewFeedback.startsWith('[file not found')) {
      sections.push(
        `\n## Review findings (previous attempt failed review)\n\nThe Review agent FAILED your previous implementation. Address every issue below before resubmitting:\n\`\`\`markdown\n${reviewFeedback}\n\`\`\``
      );
    }
  }

  // Technical plan + diagram (Review only) — Review checks the diff against
  // the Architect's intended flow, not just against prose in the brief.
  if (role === 'review') {
    const techPlanForReview = read(`${ctx.featureDir}/technical-plan.md`);
    if (techPlanForReview && !techPlanForReview.startsWith('[file not found')) {
      sections.push(
        `## Technical plan (Architect)\n\n\`\`\`markdown\n${techPlanForReview}\n\`\`\``
      );
    }
    // Adversarial-review lens: when the pipeline runs a panel of verifiers,
    // each pass gets a distinct focus via AFP_REVIEW_LENS so N reviewers
    // catch failure modes redundancy alone would miss. Absent (single
    // reviewer) → no extra focus, unchanged behavior.
    const lens = process.env.AFP_REVIEW_LENS;
    if (lens) {
      sections.push(
        `## Review focus for this pass\n\nYou are one verifier in an independent panel. Scrutinize this implementation specifically through the lens of **${lens}**. Be adversarial: actively try to find a real, blocking defect rather than confirming the happy path. If you find one, return FAIL. Still fill in the full review report.`
      );
    }
  }

  // Git diff (Review only)
  if (role === 'review') {
    try {
      const diff = execSync(
        'git diff HEAD -- . 2>/dev/null || git diff --cached -- . 2>/dev/null || echo ""',
        { encoding: 'utf-8', maxBuffer: 1024 * 1024 }
      )
        .toString()
        .trim();
      if (diff) {
        sections.push(
          `\n## Git diff (code changes)\n\nReview the actual code changes:\n\`\`\`diff\n${diff}\n\`\`\``
        );
      }
    } catch {
      // git diff may fail in non-git contexts — skip silently
    }
  }

  // For QA: framework-agnostic E2E flow listing + results contract. Which
  // E2E tool a project uses (Maestro, Playwright, Cypress, Detox, ...) is
  // entirely a project choice (`e2e.framework`/`e2e.dir` in .ai/config.json)
  // — this module doesn't run any of them itself, since orchestrating a
  // simulator/browser in CI is inherently framework- and infra-specific.
  // What it standardizes is the single handoff contract: project-specific
  // CI drops a `e2e-results.json` into the feature dir; QA reads it if
  // present and is instructed never to fabricate a result if it's absent.
  if (role === 'qa') {
    const framework = CONFIG.e2e?.framework || '';
    const e2eDir = CONFIG.e2e?.dir || 'e2e';
    if (framework) {
      sections.push(
        `## E2E framework\n\n- Framework: \`${framework}\`\n- Test directory: \`${e2eDir}\``
      );
      const patterns = E2E_FLOW_PATTERNS[framework] ?? [];
      if (existsSync(join(getRoot(), e2eDir))) {
        const flows = readdirSync(join(getRoot(), e2eDir)).filter(f =>
          patterns.length ? patterns.some(ext => f.endsWith(ext)) : true
        );
        sections.push(
          `## Existing E2E flows\n\n${flows.map(f => `- \`${f}\``).join('\n')}`
        );
      }
    } else {
      sections.push(
        `## E2E framework\n\nNo \`e2e.framework\` configured for this project. QA cannot verify E2E flows structurally — rely entirely on whether results are provided below, or on whether the brief has any E2E requirements at all.`
      );
    }

    // Read real results if available (dropped by project-specific CI —
    // this module never produces this file itself)
    const resultsPath = `${ctx.featureDir}/e2e-results.json`;
    const resultsContent = read(resultsPath);
    if (resultsContent && !resultsContent.startsWith('[file not found')) {
      sections.push(
        `## E2E test results (from CI)\n\nThe following ${framework || 'E2E'} flows were executed by this project's own CI job. Use these actual results to write your report — do NOT fabricate results or default to BLOCKED_ENV.\n\n\`\`\`json\n${resultsContent}\n\`\`\``
      );
    } else {
      sections.push(
        `## E2E test results\n\nNo results file found at \`${resultsPath}\`. This file is expected to be produced by the project's own CI job running its ${framework || 'configured'} E2E suite — this module does not execute E2E tests itself. If you cannot run the suite locally, use BLOCKED_ENV and explain why. Only use PASS without results if the brief genuinely has no E2E requirements for this feature.`
      );
    }
  }

  // Task description per role
  const tasks: Record<string, string> = {
    pm: `You are a **senior product manager**. Your job is to produce a complete, detailed feature brief — not a template.

Read the **Original GitHub issue** and the **Project directory tree** to understand the app. Study existing code patterns, screens, components, i18n keys, and analytics events referenced in the registries.

Write or update \`${ctx.featureDir}/feature-brief.md\`. Every section must be filled — no empty placeholders, no "TBD". If the issue truly lacks details, mark them explicitly as "Missing from issue #N — needs human input" and add them to **Risks & open questions**.

Preserve existing sections — only add or update the "## Scope" section. Do not rewrite sections that already have content.

Specifically:

1. **Problem & Goals** — derive from the issue, not generic text
2. **Acceptance criteria** — testable, numbered, unambiguous. Example: "Given X, when Y, then Z"
3. **UX / screens** — describe what changes on each screen. Reference existing screens from the directory tree
4. **i18n** — list every new translation key with \`en\` and \`fr\` values
5. **Analytics** — pick existing signals from the registry or define new ones with \`(NEW)\` marker
6. **Paywall** — specify free vs premium behavior per surface
7. **Technical notes** — list files likely touched based on the directory tree
8. **E2E / QA** — describe step-by-step E2E flows (in whatever framework this project has configured)
9. **Scope** — answer every question from the **Scope checklist** registry in a dedicated "## Scope" section. List what is IN/OUT, entry points, side effects, edge cases, dependencies, data storage, and screens/navigation changes.

IMPORTANT: Output the COMPLETE updated \`feature-brief.md\` in the ## Artifacts section. Do not skip sections. A weak brief wastes everyone's time.`,
    architect: `You are a **senior software architect**. Your job is to produce a precise, actionable technical plan from the approved feature brief.

Read the **Feature brief** and the **Project context** to understand the app's architecture. Study the directory tree and existing code patterns.

Write or update two artifacts:

### 1. \`${ctx.featureDir}/technical-plan.md\`

This must contain:

**Architecture** — one paragraph describing how the feature fits into the existing app structure

**Diagram** — a Mermaid diagram (\`\`\`mermaid fenced block) showing the actual flow: a sequence diagram for a new interaction/API flow, or a component/flowchart diagram for new UI or data flow. This is MANDATORY, not optional prose — the pipeline will reject the plan and retry this stage if no \`\`\`mermaid block is present. Pick whichever diagram type actually represents the feature; do not force a sequence diagram onto something that's purely structural. The Review agent will check the implementation against this diagram, not just against the prose above.

**Impacted files** — exact file paths, one per line, with a one-line description of what changes in each. Be precise:
- \`app/(tabs)/settings.tsx\` — add new settings row for X
- \`services/supabase.ts\` — add new query function
- \`i18n/locales/en.ts\` — add translation keys
- \`i18n/locales/fr.ts\` — add translation keys

**Existing patterns to reuse** — reference specific components, hooks, or services the Dev should follow

**Risks** — things that could go wrong

**Implementation order** — numbered steps in dependency order:
1. Add i18n keys
2. Add service function
3. Add UI component
4. Wire into navigation

**Testing strategy** — how to verify each acceptance criterion

**Task breakdown** — checkboxes the Dev will work through

### 2. \`${ctx.featureDir}/repository-context.md\`

This must contain:

**Relevant files** — the subset of files the Dev needs to read to understand existing patterns

**Similar features** — existing features that follow the same pattern, with file paths

**Existing conventions** — forms, validation, API calls, state management, testing patterns the Dev must follow

**Reuse opportunities** — specific components/hooks that can be reused or extended

**Files to avoid touching** — files that are out of scope

IMPORTANT: Do NOT write code. Do NOT leave sections empty or with "TBD". Every section must be actionable. The Dev will implement exactly what you specify.`,
    'dev-review': `Carefully review the feature brief and the current PM ↔ Dev thread. Check for:

1. Missing or ambiguous acceptance criteria
2. Unaddressed edge cases
3. Missing i18n, analytics, paywall, or accessibility requirements
4. Technical concerns or risky shortcuts
5. Insufficient context to implement
6. Scope checklist — verify that every question from the **Scope checklist** registry is answered in the feature brief's "## Scope" section

**Read existing threads first:** check \`pm-dev-thread.md\` in the context above. If a thread has a **Human response** section marked **Resolved**, consider the question already answered — do NOT block on it again.

**If everything is clear** → set status to **clear** (no files needed).
**If you have questions** → append a Thread entry to \`${ctx.featureDir}/pm-dev-thread.md\` with status **Open** for each question. Set status to **questions**.
**If critical info is still missing after reading the PM ↔ Dev thread** — write \`${ctx.featureDir}/blocker.md\` explaining what is missing. Set status to **blocked**.`,
    'pm-respond': `Review the open threads in \`${ctx.featureDir}/pm-dev-thread.md\`. For each thread:

1. Answer the question or clarify the requirement
2. If the brief needs updating, output the updated \`feature-brief.md\` in the ## Artifacts section
3. Mark the thread **Resolved**

If you cannot answer a question or resolve a blocker, set status to **blocked** and write \`${ctx.featureDir}/blocker.md\`.`,
    dev: `Implement the feature described in the feature brief. You MUST write actual code changes.

1. Read the **technical-plan.md** (if it exists) for exact files to modify and implementation order. The Architect has already determined what needs to change.
2. Read the **repository-context.md** (if it exists) for relevant patterns, conventions, and files to avoid touching.
3. Identify which source files need to be created or modified based on the brief's acceptance criteria and the Architect's technical plan.
4. Read the relevant files from the directory tree and code shown above.
5. In your response, output the COMPLETE content of every file in the ## Files section. Each file must include its full path and the entire file content — not just a diff or partial snippet.
6. Update \`${ctx.featureDir}/dev-log.md\` with what you did.

IMPORTANT: If you do not output any files in the ## Files section, no code changes will be made. The script writes files exactly as you provide them.`,
    review: `Review the implementation against the feature brief. Check all checklist items. Write \`${ctx.featureDir}/review-report.md\` with your verdict.

Additionally, check the git diff against the **Diagram** in the Architect's technical plan (provided above): does the actual control/data flow in the code match what the diagram describes? If the diagram shows step A calling B calling C and the diff shows a different order, a skipped step, or an extra untracked path, flag it explicitly in your report — a plan that "sounds right" in prose but was implemented differently in practice is exactly the failure mode this check exists to catch. Treat a real divergence as a FAIL, not a note, unless it's a trivial rename with no behavioral difference.`,
    qa: `Review the E2E test plan from the brief and the actual E2E test results provided in the context (see the E2E framework and E2E test results sections above — this project's configured framework, whatever it is). Write \`${ctx.featureDir}/qa-report.md\`.

If E2E results are provided (from this project's own CI), use the actual pass/fail data to write your report. Record each flow's result in the "Flows executed" table. Set verdict to PASS if all flows passed, FAIL if any failed, or BLOCKED_ENV only if results are genuinely unavailable.

If no E2E results are available, explain why in BLOCKED_ENV and create/update \`${ctx.featureDir}/blocker.md\`.`,
    retro: `You are the **retrospective** agent. Your job is to compile a squad retrospective from all artifacts produced during this feature's pipeline.

Read all available artifacts in \`${ctx.featureDir}/\`:
- \`feature-brief.md\` — what was planned
- \`technical-plan.md\` — architecture decisions
- \`repository-context.md\` — context discovered
- \`dev-log.md\` — what the dev did
- \`review-report.md\` — review findings
- \`qa-report.md\` — QA findings
- \`pm-dev-thread.md\` — discussions
- \`blocker.md\` — blockers encountered (if exists)

Also read the agent raw response logs (\`.agent-*-response.md\`) for additional context about what each agent decided.

Write \`${ctx.featureDir}/retrospective.md\` with:
1. **What was built** — summary of the feature, key files changed
2. **Decisions log** — decisions made by each role (PM, Architect, Dev, Review, QA)
3. **What went wrong** — issues encountered, failed attempts, repair loops
4. **Knowledge discovered** — things learned about the codebase (unexpected patterns, hidden dependencies, tricky areas)
5. **Patterns identified** — reusable patterns worth noting for future features
6. **Recommendations** — actionable advice for future pipeline runs
7. **Blocker log** — any blockers and how they were resolved

After writing the feature retrospective, also submit an updated \`.ai/project-memory.md\` artifact (create if missing). This file is read by EVERY role on EVERY future feature, so it must stay small and organized by fixed categories, not grow forever as one section per feature:

## Project memory (cross-session)

### Pitfalls
- ...

### Conventions confirmed
- ...

### Architecture decisions
- ...

### Integration notes
- ...

Merge your new learnings into the matching category (don't create a new \`## ${slug}\` section). Tag each new bullet with \`(${slug})\` so its origin is traceable. Keep bullets short — future agents scan this, they don't read it closely. If a category already has a bullet that's now outdated or superseded, replace it instead of appending a contradiction next to it.

Skill creation: check the "Conventions confirmed" category for a pattern that has now recurred, essentially unchanged, across 3+ different (slug) tags (e.g. "add a settings toggle" or "add an analytics event + i18n keys + registry entry" showing up the same way each time). If you find one, submit an additional artifact at \`.ai/artifacts/skill-proposals/<short-pattern-name>.md\` with: **Pattern observed**, **Evidence** (which slugs, what varied vs. stayed fixed), **Proposed skill** (inputs/outputs), and **Worth a deterministic script?** (say so explicitly if the pattern is mechanical enough to skip the LLM entirely). This is a proposal for a human to review, never something you build yourself — same design-before-implementation discipline as the Architect's plan, applied to the pipeline's own tooling. Skip this section entirely if nothing has repeated 3+ times yet; don't force a proposal just to have one.`,
    'memory-compact': `You are the **memory compaction** agent. This runs periodically (not on every feature) to keep \`.ai/project-memory.md\` useful instead of letting it grow unbounded.

Read the current \`.ai/project-memory.md\` (in the Project memory section of the context above).

Rewrite it, keeping the same four categories (Pitfalls, Conventions confirmed, Architecture decisions, Integration notes):
1. **Deduplicate** — merge bullets that say the same thing, even if worded differently or tagged with different feature slugs.
2. **Drop stale entries** — remove anything superseded by a later, more specific bullet in the same category.
3. **Keep it terse** — one line per bullet, no prose paragraphs.
4. **Preserve traceability** — keep the \`(slug)\` tags on surviving bullets so a human can still trace where a piece of memory came from.

Do NOT touch any feature artifact — this role may only submit \`.ai/project-memory.md\`. Submit the full rewritten file as a single artifact.`,
  };

  sections.push(`## Task\n\n${tasks[role]}`);

  sections.push(
    `\n\nOutput your response using the structured format specified in the system prompt.`
  );

  return sections.join('\n\n---\n\n');
}

// --- Structured output schema ---
//
// The model's entire output is validated against a JSON Schema via
// OpenRouter tool-calling (forced `submit_changes` call) instead of being
// parsed out of free-form markdown. This removes an entire class of
// silent-failure bugs where a model that drifts slightly from a prose
// format used to produce 0 parsed files/artifacts without erroring.

interface FileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  content: string;
}

interface ArtifactChange {
  path: string;
  action: 'create' | 'update';
  content: string;
}

interface AgentResult {
  files: FileChange[];
  artifacts: ArtifactChange[];
  verdict: string;
  raw: string;
  usageTokens?: number;
}

const FILE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Repo-relative source file path.' },
    action: { type: 'string', enum: ['create', 'modify', 'delete'] },
    content: {
      type: 'string',
      description:
        'The COMPLETE file content (not a diff). Empty string for delete.',
    },
  },
  required: ['path', 'action', 'content'],
  additionalProperties: false,
};

const ARTIFACT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Path under .ai/artifacts/features/<slug>/ or .ai/project-memory.md.',
    },
    action: { type: 'string', enum: ['create', 'update'] },
    content: { type: 'string' },
  },
  required: ['path', 'action', 'content'],
  additionalProperties: false,
};

// Roles without an entry here don't submit a verdict/status field.
const VERDICT_ENUM_BY_ROLE: Record<string, string[]> = {
  'dev-review': ['clear', 'questions', 'blocked'],
  'pm-respond': ['resolved', 'blocked'],
  review: ['PASS', 'PASS_WITH_NOTES', 'FAIL'],
  qa: ['PASS', 'FAIL', 'BLOCKED_ENV'],
};

function buildToolSchema(role: string): object {
  const verdictEnum = VERDICT_ENUM_BY_ROLE[role];
  const properties: Record<string, unknown> = {
    artifacts: {
      type: 'array',
      items: ARTIFACT_ITEM_SCHEMA,
      description: 'Markdown artifacts to create or update.',
    },
  };
  const required = ['artifacts'];

  if (role === 'dev') {
    properties.files = {
      type: 'array',
      items: FILE_ITEM_SCHEMA,
      description: 'Complete source files to create or modify.',
    };
    required.push('files');
  }

  if (verdictEnum) {
    properties.verdict = { type: 'string', enum: verdictEnum };
    required.push('verdict');
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function buildTool(role: string) {
  return {
    type: 'function',
    function: {
      name: 'submit_changes',
      description: `Submit the ${role} agent's complete output for this run.`,
      parameters: buildToolSchema(role),
    },
  };
}

// `tool_choice: {type:'function', function:{name:'submit_changes'}}` forces
// the model to call THIS function, but nothing enforces that its arguments
// actually satisfy the JSON Schema's `required` fields — that's purely a
// hint to the model, not a server-side content check. Found live: a real
// call (large ~87k-char user prompt) returned `{}` as the arguments —
// syntactically valid JSON, calling the right function, satisfying none of
// it. Without this check that silently became an empty AgentResult instead
// of a retry.
function missingRequiredFields(parsed: unknown, role: string): string[] {
  const schema = buildToolSchema(role) as { required?: string[] };
  const required = schema.required ?? [];
  const obj = (parsed ?? {}) as Record<string, unknown>;
  return required.filter(field => !(field in obj));
}

// Every role's task instructions spell out the exact artifact path (e.g.
// `.ai/artifacts/features/<slug>/feature-brief.md`), but the JSON Schema
// only *describes* that convention in prose, it doesn't enforce it — a
// model can (and, observed live, does) still submit a bare filename like
// "feature-brief.md" despite explicit instructions to use the full path.
// Since every artifact unambiguously belongs under this feature's own
// directory (or is .ai/project-memory.md, already anchored under .ai/),
// normalizing a path that isn't already under .ai/ is safe: it only ever
// adds the expected prefix, never redirects anywhere the model didn't
// already say to write relative to its own working directory.
function normalizeArtifactPath(path: string, slug: string): string {
  if (path.startsWith('.ai/')) return path;

  // Model included the "artifacts/features/<slug>/" segment but dropped
  // the leading ".ai/" — keep from there on rather than re-prefixing the
  // whole thing (which would double the slug directory).
  const featureDirMarker = `artifacts/features/${slug}/`;
  const markerIdx = path.indexOf(featureDirMarker);
  if (markerIdx !== -1) {
    return `.ai/${path.slice(markerIdx)}`;
  }

  // Model included just "<slug>/filename.md" (no .ai/artifacts/features/
  // prefix at all) — same fix, different starting point. Found live: two
  // consecutive real calls to the same role returned two different partial
  // forms of the same expected path, so both have to be handled, not just
  // the bare-filename case.
  const slugPrefix = `${slug}/`;
  if (path.startsWith(slugPrefix)) {
    return `.ai/artifacts/features/${path}`;
  }

  return `.ai/artifacts/features/${slug}/${path}`;
}

function parseToolArgs(argsRaw: string, role: string, slug: string): AgentResult {
  let parsed: any;
  try {
    parsed = JSON.parse(argsRaw);
  } catch (err) {
    console.error(
      `Failed to parse submit_changes arguments as JSON for role ${role}: ${err}`
    );
    console.error(argsRaw);
    process.exit(1);
  }
  const artifacts: ArtifactChange[] = Array.isArray(parsed.artifacts)
    ? parsed.artifacts.map((a: ArtifactChange) => ({
        ...a,
        path: normalizeArtifactPath(a.path, slug),
      }))
    : [];
  return {
    files: Array.isArray(parsed.files) ? parsed.files : [],
    artifacts,
    verdict: typeof parsed.verdict === 'string' ? parsed.verdict : '',
    raw: argsRaw,
  };
}

// --- LLM API dispatch ---

async function callLlm(
  role: string,
  slug: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<AgentResult> {
  if (CONFIG.llm.backend === 'claude-cli') {
    return callLlmViaClaudeCli(role, slug, model, systemPrompt, userPrompt);
  }
  return callLlmViaOpenAiCompatible(
    role,
    slug,
    model,
    systemPrompt,
    userPrompt,
    maxTokens
  );
}

// --- Backend: Claude Code CLI (subscription auth, no API key) ---
//
// Shells out to `claude -p` instead of an HTTP fetch(), for users whose only
// credential is a Claude subscription (via `claude setup-token`). Same
// AgentResult contract as the OpenAI-compatible path: schema-validated JSON
// in, AgentResult out — retries on the same kinds of transient failures,
// just keyed off exit code / `is_error` instead of HTTP status.
//
// `--tools ""` disables the CLI's own built-in tools (Edit/Bash/Write/etc)
// deliberately — this call site only wants a single structured JSON answer
// back; agent-runner.ts applies the resulting file/artifact changes itself,
// exactly as it does for the OpenRouter path. Letting the CLI use its own
// tools here would duplicate (and could conflict with) that.
const CLAUDE_CLI_RETRYABLE_TERMINAL_REASONS = new Set([
  'max_turns',
  'error_max_turns',
  'error_during_execution',
]);

type ClaudeCliEvaluation =
  | { status: 'success'; result: AgentResult }
  | { status: 'retry'; reason: string };

// Pure decision logic for a single `claude -p ... --output-format json`
// invocation's parsed stdout — separated from callLlmViaClaudeCli's
// execFileSync/retry-loop/console-logging shell so it can be unit tested
// against crafted CLI responses without actually spawning the CLI.
function evaluateClaudeCliResult(
  data: any,
  role: string,
  slug: string
): ClaudeCliEvaluation {
  if (data.is_error || CLAUDE_CLI_RETRYABLE_TERMINAL_REASONS.has(data.terminal_reason)) {
    return {
      status: 'retry',
      reason: `claude CLI reported an error (terminal_reason: ${data.terminal_reason}): ${data.result ?? JSON.stringify(data)}`,
    };
  }

  // `--json-schema` should always populate `structured_output` on success,
  // but nothing server-side guarantees it satisfies the schema's `required`
  // fields — same class of gap the OpenRouter path guards against with
  // missingRequiredFields(). Treat a missing field here as schema-invalid
  // and retry, not a silent empty AgentResult.
  const structured = data.structured_output;
  const missing = missingRequiredFields(structured, role);
  if (!structured || missing.length > 0) {
    return {
      status: 'retry',
      reason: `claude CLI structured_output missing required field(s): ${missing.join(', ') || '(no structured_output at all)'} (raw: ${data.result})`,
    };
  }

  const argsRaw = JSON.stringify(structured);
  const result = parseToolArgs(argsRaw, role, slug);
  if (typeof data.usage?.output_tokens === 'number') {
    const inputTokens =
      (data.usage.input_tokens ?? 0) +
      (data.usage.cache_read_input_tokens ?? 0) +
      (data.usage.cache_creation_input_tokens ?? 0);
    result.usageTokens = inputTokens + data.usage.output_tokens;
  }
  return { status: 'success', result };
}

async function callLlmViaClaudeCli(
  role: string,
  slug: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<AgentResult> {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;
  const schema = buildToolSchema(role);

  console.log(`  Model: ${model} (backend: claude-cli)`);
  console.log(`  System prompt: ~${systemPrompt.length} chars`);
  console.log(`  User prompt: ~${userPrompt.length} chars`);

  let lastError = '';
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const args = [
      '-p',
      userPrompt,
      '--system-prompt',
      systemPrompt,
      '--model',
      model,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--tools',
      '',
      '--no-session-persistence',
    ];
    if (CONFIG.llm.maxBudgetUsd) {
      args.push('--max-budget-usd', String(CONFIG.llm.maxBudgetUsd));
    }

    let stdout: string;
    try {
      stdout = execFileSync('claude', args, {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err: any) {
      // A non-zero exit still writes its JSON result to stdout in most
      // failure modes (e.g. is_error:true) — only fall back to the raw
      // error message when stdout truly has nothing usable.
      stdout = err?.stdout?.toString?.() ?? '';
      if (!stdout) {
        lastError = `claude CLI invocation failed: ${err?.message ?? String(err)}`;
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * Math.pow(2, attempt - 1);
          console.warn(
            `  claude CLI error (attempt ${attempt}/${MAX_RETRIES}): ${lastError}. Retrying in ${delay}ms...`
          );
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.error(
          `claude CLI kept failing after ${MAX_RETRIES} attempts: ${lastError}`
        );
        process.exit(1);
      }
    }

    let data: any;
    try {
      data = JSON.parse(stdout);
    } catch (err) {
      lastError = `claude CLI returned non-JSON output: ${err instanceof Error ? err.message : String(err)}`;
      console.error(lastError);
      console.error(stdout);
      process.exit(1);
    }

    const evaluation = evaluateClaudeCliResult(data, role, slug);

    if (evaluation.status === 'retry') {
      lastError = evaluation.reason;
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, attempt - 1);
        console.warn(
          `  claude CLI issue (attempt ${attempt}/${MAX_RETRIES}): ${lastError}. Retrying in ${delay}ms...`
        );
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.error(
        `claude CLI kept failing after ${MAX_RETRIES} attempts: ${lastError}`
      );
      process.exit(1);
    }

    console.log(`  Cost: $${data.total_cost_usd ?? 'unknown'}`);
    if (data.usage) {
      console.log(`  Usage: ${JSON.stringify(data.usage)}`);
    }
    if (typeof evaluation.result.usageTokens === 'number') {
      console.log(`  Tokens used this call: ${evaluation.result.usageTokens}`);
    }
    return evaluation.result;
  }

  console.error(`claude CLI error (exhausted retries): ${lastError}`);
  process.exit(1);
}

// --- Backend: generic OpenAI-compatible chat-completions + tool-calling ---

async function callLlmViaOpenAiCompatible(
  role: string,
  slug: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<AgentResult> {
  const apiKey = process.env[CONFIG.llm.apiKeyEnv];
  if (!apiKey) {
    console.error(`Error: ${CONFIG.llm.apiKeyEnv} env var is required`);
    process.exit(1);
  }

  const baseUrl = CONFIG.llm.baseUrl || DEFAULT_LLM_BASE_URL;
  const isOpenRouter = baseUrl.includes('openrouter.ai');

  const RETRYABLE = new Set([429, 500, 502, 503]);
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;
  const tool = buildTool(role);

  console.log(`  Model: ${model}`);
  console.log(`  System prompt: ~${systemPrompt.length} chars`);
  console.log(`  User prompt: ~${userPrompt.length} chars`);

  let lastError: string = '';
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // OpenRouter-specific attribution header — harmless to send only
          // when actually talking to OpenRouter.
          ...(isOpenRouter
            ? { 'HTTP-Referer': CONFIG.llm.refererUrl }
            : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          tools: [tool],
          tool_choice: {
            type: 'function',
            function: { name: 'submit_changes' },
          },
          max_tokens: maxTokens,
          temperature: 0.3,
          // OpenRouter-only provider-routing extension — other
          // OpenAI-compatible providers don't recognize this field.
          ...(isOpenRouter && CONFIG.llm.provider
            ? { provider: CONFIG.llm.provider }
            : {}),
        }),
      });
    } catch (err) {
      // fetch() itself can throw on network-level failures (connection
      // reset, read timeout, DNS failure) — found live: a real ETIMEDOUT
      // on a retry attempt crashed the whole process uncaught, since only
      // HTTP-level non-ok responses and schema-invalid content were
      // handled as retryable. A network hiccup deserves the same backoff
      // retry as a 502/503, not a hard crash.
      lastError = `Network error calling the LLM API: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, attempt - 1);
        console.warn(
          `  Network error (attempt ${attempt}/${MAX_RETRIES}): ${lastError}. Retrying in ${delay}ms...`
        );
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.error(
        `LLM API call failed after ${MAX_RETRIES} attempts due to network errors: ${lastError}`
      );
      process.exit(1);
    }

    if (response.ok) {
      const data: any = await response.json();
      if (data.usage) {
        console.log(`  Usage: ${JSON.stringify(data.usage)}`);
      }
      if (data.choices?.[0]?.finish_reason) {
        console.log(`  Finish reason: ${data.choices[0].finish_reason}`);
      }
      if (data.choices?.[0]?.finish_reason === 'error' || data.error) {
        console.log(`  Full response on error finish_reason: ${JSON.stringify(data)}`);
      }
      const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
      const argsRaw = toolCall?.function?.arguments;
      if (!argsRaw) {
        console.error('LLM API returned no submit_changes tool call');
        console.error(JSON.stringify(data, null, 2));
        process.exit(1);
      }
      console.log(`  Tool call arguments: ${argsRaw.length} chars`);

      let parsedForValidation: unknown = null;
      try {
        parsedForValidation = JSON.parse(argsRaw);
      } catch {
        // leave null — missingRequiredFields treats that as "everything missing"
      }
      const missing = missingRequiredFields(parsedForValidation, role);
      if (missing.length > 0) {
        lastError = `submit_changes arguments missing required field(s): ${missing.join(', ')} (raw: ${argsRaw})`;
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * Math.pow(2, attempt - 1);
          console.warn(
            `  Model returned schema-invalid arguments (attempt ${attempt}/${MAX_RETRIES}): missing ${missing.join(', ')}. Retrying in ${delay}ms...`
          );
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.error(
          `LLM API kept returning schema-invalid submit_changes arguments after ${MAX_RETRIES} attempts: missing ${missing.join(', ')}`
        );
        console.error(argsRaw);
        process.exit(1);
      }

      const result = parseToolArgs(argsRaw, role, slug);
      if (typeof data.usage?.total_tokens === 'number') {
        result.usageTokens = data.usage.total_tokens;
        console.log(`  Tokens used this call: ${result.usageTokens}`);
      }
      return result;
    }

    lastError = await response.text();
    if (RETRYABLE.has(response.status) && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, attempt - 1);
      console.warn(
        `  LLM API error (${response.status}), retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})...`
      );
      await new Promise(r => setTimeout(r, delay));
    } else {
      console.error(`LLM API error (${response.status}): ${lastError}`);
      process.exit(1);
    }
  }

  console.error(`LLM API error (exhausted retries): ${lastError}`);
  process.exit(1);
}

// --- Permissions ---

const PERMISSIONS: Record<
  string,
  {
    allowedArtifacts: RegExp[];
    allowedFiles: RegExp[];
  }
> = {
  pm: {
    allowedArtifacts: [/\.ai\/artifacts\/.*\.md$/],
    allowedFiles: [/^$/], // none
  },
  'dev-review': {
    allowedArtifacts: [/\.ai\/artifacts\/.*\.md$/],
    allowedFiles: [/^$/],
  },
  'pm-respond': {
    allowedArtifacts: [/\.ai\/artifacts\/.*\.md$/],
    allowedFiles: [/^$/],
  },
  architect: {
    allowedArtifacts: [/\.ai\/artifacts\/.*\.md$/],
    allowedFiles: [/^$/],
  },
  dev: {
    allowedArtifacts: [/dev-log\.md$/, /\.ai\/artifacts\/.*\.md$/],
    allowedFiles: [/\.(ts|tsx|js|jsx|css|json)$/, /\.ai\/artifacts\/.*\.md$/],
  },
  review: {
    allowedArtifacts: [/\.ai\/artifacts\/.*\.md$/],
    allowedFiles: [/^$/],
  },
  qa: {
    allowedArtifacts: [/\.ai\/artifacts\/.*\.md$/],
    allowedFiles: [/^$/],
  },
  retro: {
    allowedArtifacts: [/\.ai\/artifacts\/.*\.md$/, /\.ai\/project-memory\.md$/],
    allowedFiles: [/^$/],
  },
  'memory-compact': {
    // Single-purpose role: it may ONLY touch project-memory.md, not any
    // feature artifact — its whole job is to prune and restructure that
    // one file, nothing else.
    allowedArtifacts: [/\.ai\/project-memory\.md$/],
    allowedFiles: [/^$/],
  },
};

function checkPermissions(
  role: string,
  files: FileChange[],
  artifacts: ArtifactChange[]
): { allowed: boolean; blocked: string[] } {
  const perms = PERMISSIONS[role];
  const blocked: string[] = [];

  // Path containment applies to EVERY role, including ones with no
  // PERMISSIONS entry — a role's allowedFiles/allowedArtifacts regexes only
  // check the pattern of the path string (e.g. it ends in `.ts`), not that
  // it stays inside the project. `../../../tmp/pwned.ts` matches `/\.ts$/`
  // just fine, so this has to be checked independently, first.
  for (const file of files) {
    if (!isWithinRoot(file.path)) {
      blocked.push(`file: ${file.path} (escapes project root — refused)`);
      continue;
    }
    if (perms && !perms.allowedFiles.some(r => r.test(file.path))) {
      blocked.push(
        `file: ${file.path} (role ${role} cannot write source files)`
      );
    }
  }

  for (const art of artifacts) {
    if (!isWithinRoot(art.path)) {
      blocked.push(`artifact: ${art.path} (escapes project root — refused)`);
      continue;
    }
    if (perms && !perms.allowedArtifacts.some(r => r.test(art.path))) {
      blocked.push(
        `artifact: ${art.path} (role ${role} cannot write this artifact)`
      );
    }
  }

  return { allowed: blocked.length === 0, blocked };
}

// --- Application ---

function applyChanges(
  role: string,
  files: FileChange[],
  artifacts: ArtifactChange[],
  slug: string,
  isDryRun: boolean = false
) {
  console.log('\n  Applying changes...');

  const permCheck = checkPermissions(role, files, artifacts);
  if (!permCheck.allowed) {
    console.error('❌ Permission denied — blocking writes:');
    for (const b of permCheck.blocked) {
      console.error(`   ${b}`);
    }
    process.exit(1);
  }

  // Write source files
  for (const file of files) {
    const action = file.action === 'delete' ? 'delete' : 'write';
    if (isDryRun && action === 'write' && !file.path.match(/\.ai\/artifacts/)) {
      console.log(`  ⏭️  ${file.path} (skipped — dry run)`);
      continue;
    }
    if (action === 'delete' && existsSync(join(getRoot(), file.path))) {
      console.log(`  🗑️  ${file.path} (skipped delete — manual)`);
    } else {
      write(file.path, file.content);
    }
  }

  // Write artifact files
  for (const artifact of artifacts) {
    write(artifact.path, artifact.content);
  }
}

// --- Main ---

function mockResponse(role: string, slug: string): AgentResult {
  const featureDir = `.ai/artifacts/features/${slug}`;
  const base = { files: [] as FileChange[], artifacts: [] as ArtifactChange[], verdict: '', raw: '[dry-run mock]' };

  if (role === 'pm') {
    return {
      ...base,
      verdict: 'clear',
      artifacts: [
        {
          path: `${featureDir}/feature-brief.md`,
          action: 'create',
          content: `# Feature brief

**Feature slug:** ${slug}
**Tier:** M
**Status:** Draft

## Problem

Users cannot currently do X, which causes frustration.

## Goals

- Enable users to do X
- Improve retention by Y%

## Acceptance criteria

- [ ] AC1: Given user is on screen A, when they tap button B, then C happens
- [ ] AC2: Given user has done X, when they navigate away and back, state is preserved

## i18n

- \`feature.${slug}.title\`: en="My Feature", fr="Ma fonctionnalité"
- \`feature.${slug}.cta\`: en="Continue", fr="Continuer"

## Technical notes

- Files likely touched: \`app/(tabs)/settings.tsx\`, \`components/my-component.tsx\`
`,
        },
      ],
    };
  }
  if (role === 'dev-review') {
    return {
      ...base,
      verdict: 'questions',
      artifacts: [
        {
          path: `${featureDir}/pm-dev-thread.md`,
          action: 'update',
          content: `### Thread-1 — Missing AC for edge cases

**Status:** Open

**Question:** What happens when the user has no network connection?
`,
        },
      ],
    };
  }
  if (role === 'architect') {
    // Test seam: dry-run only. Lets run-pipeline.sh's diagram gate be
    // exercised end-to-end without a real model omitting the diagram.
    const includeDiagram = process.env.AFP_MOCK_ARCHITECT_NO_DIAGRAM !== '1';
    return {
      ...base,
      artifacts: [
        {
          path: `${featureDir}/technical-plan.md`,
          action: 'create',
          content: `# Technical Plan

## Architecture

One paragraph describing how the feature fits into the existing app structure.

## Diagram

${
  includeDiagram
    ? `\`\`\`mermaid
sequenceDiagram
    participant U as User
    participant UI as Settings
    participant S as Service
    U->>UI: toggles setting
    UI->>S: persist(value)
    S-->>UI: ok
\`\`\``
    : '(no diagram — test seam for the missing-diagram retry path)'
}

## Impacted Files

- \`app/(tabs)/settings.tsx\` — add new settings row for X

## Implementation Order

1. Add i18n keys
2. Wire into navigation
`,
        },
        {
          path: `${featureDir}/repository-context.md`,
          action: 'create',
          content: `# Repository Context

## Relevant Files

- \`app/(tabs)/settings.tsx\`
`,
        },
      ],
    };
  }
  if (role === 'dev') {
    return {
      ...base,
      files: [
        {
          path: 'app/(tabs)/settings.tsx',
          action: 'modify',
          content: `import { View, Text } from 'react-native';
export default function Settings() {
  return <View><Text>Hello</Text></View>;
}
`,
        },
        {
          path: 'i18n/locales/en.ts',
          action: 'modify',
          content: `export default { title: "My Feature" };\n`,
        },
      ],
      artifacts: [
        {
          path: `${featureDir}/dev-log.md`,
          action: 'create',
          content: 'Implemented feature X. Modified settings screen.\n',
        },
      ],
    };
  }
  if (role === 'review') {
    // Test seam: dry-run only. Lets run-pipeline.sh's Review→Dev retry loop
    // be exercised end-to-end without a real model returning FAIL.
    const verdict = process.env.AFP_MOCK_REVIEW_VERDICT || 'PASS';
    return {
      ...base,
      verdict,
      artifacts: [
        {
          path: `${featureDir}/review-report.md`,
          action: 'create',
          content: `# Review report

**Verdict:** ${verdict}
${verdict === 'FAIL' ? 'Missing error handling on the settings toggle.' : 'All AC checked, code is clean.'}
`,
        },
      ],
    };
  }
  if (role === 'qa') {
    return {
      ...base,
      verdict: 'PASS',
      artifacts: [
        {
          path: `${featureDir}/qa-report.md`,
          action: 'create',
          content: `# QA report

**Feature slug:** \`${slug}\`
**Verdict:** PASS
**Agent:** QA
**E2E framework:** \`${CONFIG.e2e?.framework || 'none configured'}\`

**App ID:** \`${CONFIG.project.appId}\`

---

## Flows executed

| Flow file                | Result |
| ------------------------- | ------ |
| \`e2e/onboarding.spec.ts\` | pass   |

## Environment

- Locale: en

## BLOCKED_ENV

N/A — E2E suite ran successfully.

## Notes for human MR

- All flows passed.
`,
        },
      ],
    };
  }
  if (role === 'memory-compact') {
    return {
      ...base,
      artifacts: [
        {
          path: '.ai/project-memory.md',
          action: 'update',
          content: `## Project memory (cross-session)

### Pitfalls
- (compacted) duplicate pitfalls merged

### Conventions confirmed
- (compacted)

### Architecture decisions
- (compacted)

### Integration notes
- (compacted)
`,
        },
      ],
    };
  }
  return { ...base, verdict: 'clear' };
}

// --- Token budget (circuit breaker) ---
//
// A retry loop that goes wrong (typecheck/lint/review retries stacking
// across several stages) has no ceiling on total OpenRouter spend today.
// This tracks cumulative real token usage per feature and, if
// project.maxTokensPerFeature is configured, refuses to make further calls
// once it's exceeded — a human has to explicitly raise the budget or take
// over rather than the pipeline silently spending without limit.

interface TokenUsage {
  totalTokens: number;
  calls: { role: string; tokens: number }[];
}

function loadTokenUsage(featureDir: string): TokenUsage {
  const raw = read(`${featureDir}/.agent-token-usage.json`);
  if (!raw || raw.startsWith('[file not found')) {
    return { totalTokens: 0, calls: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      totalTokens: typeof parsed.totalTokens === 'number' ? parsed.totalTokens : 0,
      calls: Array.isArray(parsed.calls) ? parsed.calls : [],
    };
  } catch {
    return { totalTokens: 0, calls: [] };
  }
}

function saveTokenUsage(featureDir: string, usage: TokenUsage): void {
  write(`${featureDir}/.agent-token-usage.json`, JSON.stringify(usage, null, 2));
}

function isOverBudget(usage: TokenUsage, budget: number | undefined): boolean {
  return typeof budget === 'number' && budget > 0 && usage.totalTokens >= budget;
}

async function main() {
  const args = parseArgs();
  const { role, slug } = args;
  const config = getRoles()[role];
  const isDryRun = args['dry-run'] === 'true';

  // Allow env var override per role: OPENROUTER_MODEL_PM, OPENROUTER_MODEL_DEV, etc.
  const envVarKey = `OPENROUTER_MODEL_${role.toUpperCase().replace(/-/g, '_')}`;
  const envOverride = (process.env as Record<string, string | undefined>)[
    envVarKey
  ];
  if (envOverride) {
    config.model = envOverride;
  }

  console.log(`\n🤖 Agent: ${role.toUpperCase()} | Feature: ${slug}`);
  console.log(`   ${config.description}`);
  console.log(`   Model: ${config.model}`);

  // 1. Load context
  console.log('\n  Loading context...');
  const ctx = loadContext(role, slug);

  // Token budget check — real calls only, dry-run never spends anything.
  if (!isDryRun) {
    const usage = loadTokenUsage(ctx.featureDir);
    const budget = CONFIG.project.maxTokensPerFeature;
    if (isOverBudget(usage, budget)) {
      console.error(
        `❌ Token budget exceeded for feature "${slug}": ${usage.totalTokens}/${budget} tokens already spent.`
      );
      console.error(
        `   Raise project.maxTokensPerFeature in .ai/config.json, or take over this feature manually.`
      );
      process.exit(1);
    }
  }

  // 2. Load skill prompt.
  //
  // AFP_SKILL_<ROLE> lets you run a role with an ALTERNATE prompt file
  // without editing agents.json — the knob for A/B-testing a prompt change
  // (e.g. AFP_SKILL_PM=.ai/experiments/pm-v2.md). The prompt hash recorded
  // in provenance is computed from whatever file is actually used, so an
  // experiment's output is auditable and comparable via the eval harness.
  const skillEnvKey = `AFP_SKILL_${role.toUpperCase().replace(/-/g, '_')}`;
  const skillOverride = (process.env as Record<string, string | undefined>)[
    skillEnvKey
  ];
  const skillPath = skillOverride || config.skill;
  const skillContent = read(skillPath);
  if (skillOverride) {
    if (skillContent.startsWith('[file not found')) {
      console.warn(
        `  ⚠️  ${skillEnvKey}=${skillOverride} not found or outside project root — falling back would be silent, aborting.`
      );
      process.exit(1);
    }
    console.log(`  Prompt override: ${skillEnvKey}=${skillPath}`);
  }

  // Provenance: which prompt version drove this agent. A short content hash
  // of the role's skill prompt — recorded in the status file so the commit
  // for this stage can carry `AFP-Model` / `AFP-Prompt-SHA` trailers. That
  // makes each stage's output reproducible/auditable ("which model and
  // which prompt produced this?") without diffing prose.
  const promptSha = createHash('sha256').update(skillContent).digest('hex').slice(0, 12);

  // 3. Build prompts
  console.log('  Building prompts...');
  const systemPrompt = buildSystemPrompt(role, skillContent);
  const userPrompt = buildUserPrompt(role, slug, ctx, config);

  // 4. Call the LLM API (or use mock for dry-run) — output is already
  // schema-validated JSON from the submit_changes tool call, no parsing step.
  let result: AgentResult;
  if (isDryRun) {
    console.log('  DRY RUN — using mock response');
    result = mockResponse(role, slug);
  } else {
    console.log('  Calling the LLM API...');
    result = await callLlm(
      role,
      slug,
      config.model,
      systemPrompt,
      userPrompt,
      config.maxTokens
    );
  }
  const { files, artifacts, verdict } = result;

  // Record real token spend against this feature's cumulative budget.
  if (!isDryRun && typeof result.usageTokens === 'number') {
    const usage = loadTokenUsage(ctx.featureDir);
    usage.totalTokens += result.usageTokens;
    usage.calls.push({ role, tokens: result.usageTokens });
    saveTokenUsage(ctx.featureDir, usage);
    const budget = CONFIG.project.maxTokensPerFeature;
    if (budget && budget > 0) {
      console.log(
        `  Cumulative tokens for "${slug}": ${usage.totalTokens}/${budget}`
      );
    }
  }

  // Save raw tool-call arguments for debugging
  const responseLogPath = `${ctx.featureDir}/.agent-${role}-response.md`;
  write(
    responseLogPath,
    `# ${role.toUpperCase()} agent response for ${slug}\n\n` +
      `## Verdict\n\n${verdict || 'none'}\n\n` +
      `## Files found\n\n${files.length}\n\n` +
      `## Artifacts found\n\n${artifacts.length}\n\n` +
      `## Raw submit_changes arguments\n\n\`\`\`json\n${result.raw}\n\`\`\`\n`
  );

  // Write machine-readable status flag for the workflow
  const statusFlagPath = `${ctx.featureDir}/.agent-status.json`;
  const roleStatusFlagPath = `${ctx.featureDir}/.agent-status-${role}.json`;
  const statusData = {
    role,
    slug,
    verdict: verdict || 'none',
    files: files.length,
    artifacts: artifacts.length,
    model: config.model,
    promptSha,
  };
  write(statusFlagPath, JSON.stringify(statusData, null, 2));
  write(roleStatusFlagPath, JSON.stringify(statusData, null, 2));

  // Save manifest of parsed files for downstream verification
  const manifestPath = `${ctx.featureDir}/.agent-${role}-manifest.json`;
  const manifestData = {
    role,
    slug,
    verdict: verdict || 'none',
    model: config.model,
    promptSha,
    files: files.map(f => ({ path: f.path, action: f.action })),
    artifacts: artifacts.map(a => ({ path: a.path, action: a.action })),
  };
  write(manifestPath, JSON.stringify(manifestData, null, 2));

  console.log(
    `  Found: ${files.length} file(s), ${artifacts.length} artifact(s)`
  );
  if (verdict) console.log(`  Verdict: ${verdict}`);

  // 6. Apply changes
  applyChanges(role, files, artifacts, slug, isDryRun);

  // 7. Summary
  console.log(`\n✅ ${role.toUpperCase()} agent complete for ${slug}`);
  if (verdict) {
    console.log(`   Verdict: ${verdict}`);
  }

  // Machine-parseable status line for the workflow
  console.log(
    `[agent-status] role=${role} verdict=${verdict || 'none'} files=${files.length} artifacts=${artifacts.length}`
  );
}

const isMain =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export {
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
  missingRequiredFields,
  trimContextForPrompt,
  evaluateClaudeCliResult,
};
export type { FileChange, ArtifactChange, AgentResult, TokenUsage };
