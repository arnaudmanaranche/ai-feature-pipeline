#!/usr/bin/env npx tsx
// Multi-agent orchestration via OpenRouter — AI Feature Pipeline module
// Usage: node scripts/agent-runner.ts --role=<role> --slug=<slug> [--project-root=<path>]
// Requires: OPENROUTER_API_KEY env var (or configured in .ai/config.json)

// dotenv is optional — load via dynamic import so the script works without it
import { execSync } from 'child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { pathToFileURL } from 'url';

// Project root: default to cwd, override with --project-root.
// Resolved lazily (not cached) so tests can chdir() into a fixture root.
function getRoot(): string {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--project-root=(.+)$/);
    if (m) return m[1];
  }
  return process.cwd();
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
  };
  bot: { name: string; email: string };
  commands: {
    packageManager: string;
    runScript: string;
    typecheck: string;
    lint: string;
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
  openRouter: { apiKeyEnv: string; model: string; refererUrl: string };
  sourceDirs: string[];
  skipDirs: string[];
  providerNesting: string[];
}

function loadProjectConfig(): ProjectConfig {
  const configPath = join(getRoot(), '.ai/config.json');
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
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
      openRouter: {
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

function loadRegistry(): Record<string, RoleConfig> {
  const registryPath = join(getRoot(), '.ai/agents.json');
  try {
    const raw = readFileSync(registryPath, 'utf-8');
    const data = JSON.parse(raw);
    return data.roles;
  } catch (err) {
    console.error(`Failed to load registry from ${registryPath}: ${err}`);
    process.exit(1);
  }
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
  const fullPath = join(getRoot(), path);
  try {
    return readFileSync(fullPath, 'utf-8');
  } catch {
    return `[file not found: ${path}]`;
  }
}

function write(path: string, content: string) {
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
      ? `For QA: if Maestro results are provided in the context, use them to determine PASS/FAIL. If no results are available and you cannot run Maestro locally, use BLOCKED_ENV and note why — do not fabricate results.`
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

  // Cross-session project memory (PM, Architect, Retro use this)
  if (role === 'pm' || role === 'architect' || role === 'retro') {
    const memory = read('.ai/project-memory.md');
    if (memory && !memory.startsWith('[file not found')) {
      sections.push(
        `## Project memory (cross-session)\n\n\`\`\`markdown\n${memory}\n\`\`\``
      );
    }
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
      sections.push(`## Architecture maps\n\n\`\`\`json\n${ctxData}\n\`\`\``);
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
    // Typecheck feedback (for Dev retry on typecheck failure)
    const typecheckFeedback = read(
      `${ctx.featureDir}/.agent-typecheck-feedback.md`
    );
    if (typecheckFeedback && !typecheckFeedback.startsWith('[file not found')) {
      sections.push(
        `\n## Typecheck errors (previous attempt)\n\nFix ALL of these TypeScript errors:\n\`\`\`\n${typecheckFeedback}\n\`\`\``
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

  // For QA: add Maestro flow info and real results
  if (role === 'qa') {
    const maestroDir = 'e2e/maestro';
    if (existsSync(join(getRoot(), maestroDir))) {
      const flows = readdirSync(join(getRoot(), maestroDir)).filter(f =>
        f.endsWith('.yaml')
      );
      sections.push(
        `## Existing Maestro flows\n\n${flows.map(f => `- \`${f}\``).join('\n')}`
      );
    }
    // Read real Maestro results if available (from pre-flight step)
    const resultsPath = `${ctx.featureDir}/maestro-results.json`;
    const resultsContent = read(resultsPath);
    if (resultsContent && !resultsContent.startsWith('[file not found')) {
      sections.push(
        `## Maestro test results (from CI)\n\nThe following Maestro flows were executed on a real iOS Simulator. Use these actual results to write your report — do NOT fabricate results or default to BLOCKED_ENV.\n\n\`\`\`json\n${resultsContent}\n\`\`\``
      );
    } else {
      sections.push(
        `## Maestro test results\n\nNo Maestro results file found at \`${resultsPath}\`. If you cannot run Maestro locally, use BLOCKED_ENV and explain why. If flows look correct based on the brief, you may use PASS.`
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
8. **Maestro / QA** — describe step-by-step E2E flows
9. **Scope** — answer every question from the **Scope checklist** registry in a dedicated "## Scope" section. List what is IN/OUT, entry points, side effects, edge cases, dependencies, data storage, and screens/navigation changes.

IMPORTANT: Output the COMPLETE updated \`feature-brief.md\` in the ## Artifacts section. Do not skip sections. A weak brief wastes everyone's time.`,
    architect: `You are a **senior software architect**. Your job is to produce a precise, actionable technical plan from the approved feature brief.

Read the **Feature brief** and the **Project context** to understand the app's architecture. Study the directory tree and existing code patterns.

Write or update two artifacts:

### 1. \`${ctx.featureDir}/technical-plan.md\`

This must contain:

**Architecture** — one paragraph describing how the feature fits into the existing app structure

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
    review: `Review the implementation against the feature brief. Check all checklist items. Write \`${ctx.featureDir}/review-report.md\` with your verdict.`,
    qa: `Review the Maestro E2E test plan from the brief and the actual Maestro test results provided in the context. Write \`${ctx.featureDir}/qa-report.md\`.

If Maestro results are provided (from CI pre-flight), use the actual pass/fail data to write your report. Record each flow's result in the "Flows executed" table. Set verdict to PASS if all flows passed, FAIL if any failed, or BLOCKED_ENV only if results are genuinely unavailable.

If no Maestro results are available, explain why in BLOCKED_ENV and create/update \`${ctx.featureDir}/blocker.md\`.`,
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

After writing the feature retrospective, also append key learnings to \`.ai/project-memory.md\` (create if missing) under a \`## ${slug}\` section. This cross-session memory file helps future PM and Architect agents make better decisions. Include:
- Architecture patterns discovered
- Common pitfalls in this codebase
- Useful conventions observed
- Integration notes (which services touch what)`,
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

function parseToolArgs(argsRaw: string, role: string): AgentResult {
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
  return {
    files: Array.isArray(parsed.files) ? parsed.files : [],
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    verdict: typeof parsed.verdict === 'string' ? parsed.verdict : '',
    raw: argsRaw,
  };
}

// --- OpenRouter API ---

async function callOpenRouter(
  role: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<AgentResult> {
  const apiKey = process.env[CONFIG.openRouter.apiKeyEnv];
  if (!apiKey) {
    console.error(`Error: ${CONFIG.openRouter.apiKeyEnv} env var is required`);
    process.exit(1);
  }

  const RETRYABLE = new Set([429, 500, 502, 503]);
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;
  const tool = buildTool(role);

  console.log(`  Model: ${model}`);
  console.log(`  System prompt: ~${systemPrompt.length} chars`);
  console.log(`  User prompt: ~${userPrompt.length} chars`);

  let lastError: string = '';
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': CONFIG.openRouter.refererUrl,
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
        }),
      }
    );

    if (response.ok) {
      const data = await response.json();
      const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
      const argsRaw = toolCall?.function?.arguments;
      if (!argsRaw) {
        console.error('OpenRouter returned no submit_changes tool call');
        console.error(JSON.stringify(data, null, 2));
        process.exit(1);
      }
      console.log(`  Tool call arguments: ${argsRaw.length} chars`);
      return parseToolArgs(argsRaw, role);
    }

    lastError = await response.text();
    if (RETRYABLE.has(response.status) && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, attempt - 1);
      console.warn(
        `  OpenRouter error (${response.status}), retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})...`
      );
      await new Promise(r => setTimeout(r, delay));
    } else {
      console.error(`OpenRouter API error (${response.status}): ${lastError}`);
      process.exit(1);
    }
  }

  console.error(`OpenRouter API error (exhausted retries): ${lastError}`);
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
};

function checkPermissions(
  role: string,
  files: FileChange[],
  artifacts: ArtifactChange[]
): { allowed: boolean; blocked: string[] } {
  const perms = PERMISSIONS[role];
  if (!perms) return { allowed: true, blocked: [] };

  const blocked: string[] = [];

  for (const file of files) {
    const ok = perms.allowedFiles.some(r => r.test(file.path));
    if (!ok)
      blocked.push(
        `file: ${file.path} (role ${role} cannot write source files)`
      );
  }

  for (const art of artifacts) {
    const ok = perms.allowedArtifacts.some(r => r.test(art.path));
    if (!ok)
      blocked.push(
        `artifact: ${art.path} (role ${role} cannot write this artifact)`
      );
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
    return {
      ...base,
      verdict: 'PASS',
      artifacts: [
        {
          path: `${featureDir}/review-report.md`,
          action: 'create',
          content: `# Review report

**Verdict:** PASS
All AC checked, code is clean.
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
          content: `# QA report (Maestro)

**Feature slug:** \`${slug}\`
**Verdict:** PASS
**Agent:** QA

**App ID:** \`${CONFIG.project.appId}\`

---

## Flows executed

| Flow file                     | Command            | Result |
| ----------------------------- | ------------------ | ------ |
| \`e2e/maestro/onboarding.yaml\` | \`maestro test ...\` | pass   |

## Environment

- Platform: iOS Simulator
- Build: Release
- Locale: en

## BLOCKED_ENV

N/A — Maestro ran successfully.

## Notes for human MR

- All flows passed.
`,
        },
      ],
    };
  }
  return { ...base, verdict: 'clear' };
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

  // 2. Load skill prompt
  const skillContent = read(config.skill);

  // 3. Build prompts
  console.log('  Building prompts...');
  const systemPrompt = buildSystemPrompt(role, skillContent);
  const userPrompt = buildUserPrompt(role, slug, ctx, config);

  // 4. Call OpenRouter (or use mock for dry-run) — output is already
  // schema-validated JSON from the submit_changes tool call, no parsing step.
  let result: AgentResult;
  if (isDryRun) {
    console.log('  DRY RUN — using mock response');
    result = mockResponse(role, slug);
  } else {
    console.log('  Calling OpenRouter...');
    result = await callOpenRouter(
      role,
      config.model,
      systemPrompt,
      userPrompt,
      config.maxTokens
    );
  }
  const { files, artifacts, verdict } = result;

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
  };
  write(statusFlagPath, JSON.stringify(statusData, null, 2));
  write(roleStatusFlagPath, JSON.stringify(statusData, null, 2));

  // Save manifest of parsed files for downstream verification
  const manifestPath = `${ctx.featureDir}/.agent-${role}-manifest.json`;
  const manifestData = {
    role,
    slug,
    verdict: verdict || 'none',
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
};
export type { FileChange, ArtifactChange, AgentResult };
