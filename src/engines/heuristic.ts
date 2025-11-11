import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';

export async function generateHeuristic(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  const { files } = changes;
  const variant = (config as any).regen ?? 0;

  // Detect change type
  const type = detectChangeType(files, changes.diff);

  // Extract scope from file paths
  const scope = detectScope(files);

  // Extract topics from diff for richer subjects
  const topics = extractTopics(changes.diff);

  // Split into code/docs groups for possible compound messages
  const docsFiles = files.filter(f => isDocFile(f.path));
  const codeFiles = files.filter(f => !isDocFile(f.path));

  // Build subject from files and summaries
  // For conv style, prefer a noun-phrase subject to avoid verb duplication
  const subjectWithVerb = buildSubject(files, type, true);
  const subjectNoun = buildSubject(files, type, false);

  // Generate three diverse candidates
  const candidates: string[] = [];

  // If mixed docs + code, compose a compound message
  const isMixed = docsFiles.length > 0 && codeFiles.length > 0;

  if (config.style === 'conv' || config.style === 'mix') {
    // Conventional Commits format
    if (isMixed) {
      const codeType = detectChangeType(codeFiles, changes.diff);
      const codeScope = detectScope(codeFiles) || scope;
      const docsScope = docsFiles.some(f => /README\.md$/i.test(f.path)) ? 'readme' : '';
      const codeNoun = topics.length > 0 ? topicsToPhrase(topics, variant) : buildSubject(codeFiles, codeType, false);
      const left = `${codeType}${codeScope ? `(${codeScope})` : ''}: ${codeNoun}`;
      const right = `docs: ${docsScope ? (docsScope === 'readme' ? 'update README' : 'update docs') : 'update docs'}`;
      candidates.push(`${left}; ${right}`);
    } else {
      const scopePart = scope ? `(${scope})` : '';
      const noun = topics.length > 0 ? topicsToPhrase(topics, variant) : subjectNoun;
      candidates.push(`${type}${scopePart}: ${noun}`);
    }
  }

  if (config.style === 'plain' || config.style === 'mix') {
    // Plain imperative
    if (isMixed) {
      const codeType = detectChangeType(codeFiles, changes.diff);
      const codeScope = detectScope(codeFiles) || scope;
      const docsScope = docsFiles.some(f => /README\.md$/i.test(f.path)) ? 'README' : 'docs';
      const verbCode = pickVerb(codeType, 'code', variant);
      const verbDocs = pickVerb('docs', 'docs', variant);
      const topicPhrase = topics.length > 0 ? topicsToPhrase(topics, variant) : (codeScope || 'implementation');
      const left = `${capitalizeFirst(verbCode)} ${codeScope ? `${codeScope} ` : ''}${topicPhrase}`.trim();
      const right = `${verbDocs} ${docsScope}`;
      candidates.push(`${left} and ${right}`);
    } else {
      const verbish = topics.length > 0 ? `${getDefaultVerb(type, variant)} ${topicsToPhrase(topics, variant)}` : subjectWithVerb;
      candidates.push(capitalizeFirst(verbish));
    }
  }

  if (config.style === 'gitmoji' || config.style === 'mix') {
    // Gitmoji style
    const emoji = getEmoji(type);
    if (isMixed) {
      const codeType = detectChangeType(codeFiles, changes.diff);
      const codeScope = detectScope(codeFiles) || scope;
      const docsScope = docsFiles.some(f => /README\.md$/i.test(f.path)) ? 'README' : 'docs';
      const verbCode = pickVerb(codeType, 'code', variant);
      const topicPhrase = topics.length > 0 ? topicsToPhrase(topics, variant) : (codeScope || 'implementation');
      const left = `${getEmoji(codeType)} ${codeScope ? `${codeScope}: ` : ''}${verbCode} ${topicPhrase}`;
      const right = `📝 ${pickVerb('docs', 'docs', variant)} ${docsScope}`;
      candidates.push(`${left}; ${right}`);
    } else {
      const scopePart = scope ? `${scope}: ` : '';
      const body = topics.length > 0 ? `${getDefaultVerb(type, variant)} ${topicsToPhrase(topics, variant)}` : subjectWithVerb;
      candidates.push(`${emoji} ${scopePart}${body}`);
    }
  }

  // Fill remaining slots if needed
  while (candidates.length < 3) {
    const alt = generateAlternative(files, type, scope, variant, candidates.length);
    if (!candidates.includes(alt)) {
      candidates.push(alt);
    } else {
      break;
    }
  }
  return candidates.slice(0, 3);
}

function detectChangeType(files: any[], diff: string): string {
  // Check docs first - highest priority when all changed files are docs
  const allDocs = files.every(f => /\.(md|txt|rst|adoc)$/i.test(f.path));
  if (allDocs) return 'docs';

  const addedCode = files.some(f => f.status === 'A' && /\.(tsx?|jsx?|py|go|rs|java|cs|rb|php)$/.test(f.path));
  const hasNewKeywords = /\bnew\s+(feature|component|function|class|endpoint|route|api)\b/i.test(diff) ||
    /\badd(ed|ing)?\s+(feature|component|function|class)\b/i.test(diff);

  const fixStrong = /\b(fix|bug|issue|patch|resolve[sd]?)\b/i.test(diff);
  const fixWeakSignals = [
    /\b(throw|catch|try|error|exception)\b/i,
    /\b(null|undefined).*check\b/i,
    /test.*fail/i,
  ];
  const fixWeakCount = fixWeakSignals.filter(r => r.test(diff)).length;

  const isTestChange = files.some(f => /\.test\.|_test\.|spec\.|__tests__/.test(f.path)) ||
    /\b(test|spec|jest|mocha|pytest)\b/i.test(diff);

  const isRefactor = /\b(refactor|restructure|reorganize|cleanup|simplify)\b/i.test(diff) ||
    (files.every(f => f.status === 'M' && f.additions > 0 && f.deletions > 0) && !addedCode);

  const isStyle = files.some(f => /\.(css|scss|less|styl)$/.test(f.path)) ||
    /\b(style|format|prettier|eslint|lint)\b/i.test(diff);

  const isChore = files.some(f => /(package\.json|package-lock|yarn\.lock|Cargo\.toml|go\.mod)/.test(f.path)) ||
    /\b(deps|dependencies|version|config)\b/i.test(diff);

  // Determine type using stronger, corroborated signals
  if (addedCode && hasNewKeywords) return 'feat';
  if (fixStrong && (fixWeakCount >= 1 || isTestChange)) return 'fix';
  if (isTestChange) return 'test';
  if (isRefactor) return 'refactor';
  if (isStyle) return 'style';
  if (isChore) return 'chore';

  return files[0]?.status === 'A' ? 'feat' : 'chore';
}

function detectScope(files: any[]): string {
  if (files.length === 0) return '';

  // Strategy 1: Domain-based detection from file paths
  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const paths = files.map(f => normalize(f.path));

  // Domain-based detection
  const domains = {
    auth: /\b(auth|login|session|token|oauth|jwt)\b/,
    api: /\b(api|endpoint|route|controller)\b/,
    ui: /\b(ui|component|view|page|layout)\b/,
    db: /\b(database|db|model|schema|migration)\b/,
    config: /\b(config|setting|env)\b/,
    test: /\b(test|spec|__tests__)\b/,
    build: /\b(build|webpack|vite|rollup|babel)\b/,
    cli: /\b(cli|command|bin)\b/,
    docs: /\b(readme|docs|changelog|contributing)\b|\.(md|rst|adoc)\b/,
    engine: /\b(engine|engines|heuristic|ollama)\b/,
  } as Record<string, RegExp>;

  for (const [domain, pattern] of Object.entries(domains)) {
    if (paths.some((p: string) => pattern.test(p))) {
      return domain;
    }
  }

  // Strategy 2: Common parent directory
  if (files.length === 1) {
    const parts = normalize(files[0].path).split('/').slice(0, -1);
    const meaningful = parts.filter((p: string) => !['src', 'lib', 'dist', 'build', '.', 'node_modules', 'packages', 'apps', 'public', 'assets', 'scripts'].includes(p));
    const scope = meaningful.pop();
    return scope && scope.length <= 15 ? scope : '';
  }

  // Strategy 3: Find longest common prefix for multiple files
  const allParts = paths.map((p: string) => p.split('/').slice(0, -1));
  const commonParts: string[] = [];
  const minLength = Math.min(...allParts.map((p: string[]) => p.length));

  for (let i = 0; i < minLength; i++) {
    const part = allParts[0][i];
    if (allParts.every((p: string[]) => p[i] === part)) {
      commonParts.push(part);
    } else {
      break;
    }
  }

  const meaningful = commonParts.filter((p: string) => !['src', 'lib', 'dist', 'build', '.', 'node_modules', 'packages', 'apps', 'public', 'assets', 'scripts'].includes(p));
  const scope = meaningful.pop();
  return scope && scope.length <= 15 ? scope : '';
}

function isDocFile(path: string): boolean {
  return /\.(md|txt|rst|adoc)$/i.test(path);
}

function extractTopics(diff: string): string[] {
  if (!diff) return [];
  const topics = new Set<string>();

  const addIf = (re: RegExp, label: string) => { if (re.test(diff)) topics.add(label); };

  // Function identifiers → human phrases
  addIf(/\bdetectScope\b/, 'scope detection');
  addIf(/\bcategorizeFiles\b/, 'categorization');
  addIf(/\bdetectChangeType\b/, 'type detection');
  addIf(/\bbuildSubject\b/, 'subject generation');
  addIf(/\bgenerateAlternative\b/, 'alternatives');
  addIf(/\bgetAction\b/, 'verb selection');

  // Keyword cues
  addIf(/\bscope\b/i, 'scope detection');
  addIf(/\bcategor(y|ies|ization)\b/i, 'categorization');
  addIf(/\bheuristic\b/i, 'heuristic logic');

  return Array.from(topics).slice(0, 3);
}

function topicsToPhrase(topics: string[], variant: number): string {
  const t = topics.filter(Boolean);
  if (t.length === 0) return '';
  if (t.length === 1) return t[0];
  const idx = seededIndex(t.length, variant, 1);
  const first = t[idx % t.length];
  const second = t[(idx + 1) % t.length];
  return `${first} and ${second}`;
}

function pickVerb(type: string, domain: 'code' | 'docs', variant: number): string {
  const pools: Record<string, string[]> = {
    docs: ['clarify', 'update', 'improve'],
    refactor: ['adjust', 'refactor', 'simplify'],
    chore: ['refine', 'update', 'tune'],
    feat: ['introduce', 'add'],
    fix: ['fix', 'address', 'resolve'],
    perf: ['optimize', 'improve'],
    default: ['update', 'improve'],
  };
  const key = domain === 'docs' ? 'docs' : (pools[type] ? type : 'default');
  const pool = pools[key] || pools.default;
  const salt = key.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const idx = seededIndex(pool.length, variant, salt);
  return pool[idx];
}

function getDefaultVerb(type: string, variant: number): string {
  return pickVerb(type, 'code', variant);
}

function buildSubject(files: any[], type: string, includeVerb: boolean = true): string {
  if (files.length === 1) {
    const file = files[0];
    const normPath = file.path.replace(/\\/g, '/');
    const fileName = normPath.split('/').pop()?.replace(/\.[^.]+$/, '');
    const action = getAction(file.status, type);

    if (file.summary) {
      const ids = file.summary.split(',')[0].trim();
      return includeVerb ? `${action} ${ids} in ${fileName}` : `${ids} in ${fileName}`;
    }

    return includeVerb ? `${action} ${fileName}` : `${fileName}`;
  }

  // Multiple files
  const action = getAction(files[0].status, type);
  const categories = categorizeFiles(files);

  if (categories.size === 1) {
    const [category] = categories.keys();
    return includeVerb ? `${action} ${category} across ${files.length} files` : `${category} across ${files.length} files`;
  }

  const topCategories = Array.from(categories.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([cat]) => cat);

  if (topCategories.length === 2) {
    return includeVerb ? `${action} ${topCategories[0]} and ${topCategories[1]}` : `${topCategories[0]} and ${topCategories[1]}`;
  }

  return includeVerb ? `${action} ${files.length} files` : `${files.length} files`;
}

function getAction(status: string, type: string, fileCount: number = 1): string {
  if (status === 'A') return type === 'feat' ? 'add' : 'create';
  if (status === 'D') return fileCount > 1 ? 'remove' : 'remove';
  if (status === 'R') return fileCount > 1 ? 'rename' : 'rename';

  // Modified - choose verb based on type
  const actions: Record<string, string> = {
    feat: 'add',
    fix: 'fix',
    refactor: 'refactor',
    docs: 'update',
    test: 'update',
    style: 'style',
    chore: 'update',
    perf: 'optimize',
  };

  return actions[type] || 'update';
}

function categorizeFiles(files: any[]): Map<string, number> {
  const categories = new Map<string, number>();

  for (const file of files) {
    let category = 'files';
    const path = file.path.replace(/\\/g, '/');

    if (/\.(tsx|jsx)$/.test(path)) {
      category = 'components';
    } else if (/\.(ts|js)$/.test(path)) {
      if (path.includes('/engines/')) category = 'engine';
      else category = 'code';
    } else if (/\.(css|scss|less)$/.test(path)) {
      category = 'styles';
    } else if (/\.test\.|\.spec\.|__tests__/.test(path)) {
      category = 'tests';
    } else if (/\.(md|txt)$/.test(path)) {
      category = 'docs';
    } else if (/api|route|endpoint/.test(path)) {
      category = 'API';
    } else if (/config|settings/.test(path)) {
      category = 'config';
    } else if (/\.py$/.test(path)) {
      category = 'modules';
    }

    categories.set(category, (categories.get(category) || 0) + 1);
  }

  return categories;
}

function getEmoji(type: string): string {
  const emojis: Record<string, string> = {
    feat: '✨',
    fix: '🐛',
    docs: '📝',
    style: '💄',
    refactor: '♻️',
    test: '✅',
    chore: '🔧',
    perf: '⚡',
    build: '📦',
    ci: '👷',
    revert: '⏪',
  };

  return emojis[type] || '🔨';
}

export function capitalizeFirst(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function generateAlternative(files: any[], type: string, scope: string, variant: number, index: number): string {
  const target = scope || 'code';
  const shortList = files
    .map(f => f.path.replace(/\\/g, '/').split('/').pop())
    .filter(Boolean)
    .slice(0, 2)
    .join(' and ');

  const byType: Record<string, string[]> = {
    feat: [
      `introduce ${target} changes`,
      `add improvements to ${target}`,
      `implement updates in ${shortList || target}`,
    ],
    fix: [
      `address issues in ${target}`,
      `fix problems in ${shortList || target}`,
      `resolve edge cases in ${target}`,
    ],
    refactor: [
      `simplify ${target} structure`,
      `refactor ${shortList || target}`,
      `clean up ${target}`,
    ],
    docs: [
      `update documentation`,
      `clarify README`,
      `improve docs for ${target}`,
    ],
    test: [
      `add or update tests`,
      `improve test coverage`,
      `adjust tests for ${shortList || target}`,
    ],
    style: [
      `apply formatting updates`,
      `style tweaks in ${shortList || target}`,
      `format ${target}`,
    ],
    chore: [
      `update configuration`,
      `maintenance updates`,
      `tune settings for ${target}`,
    ],
    perf: [
      `optimize ${target} performance`,
      `improve efficiency in ${shortList || target}`,
      `performance tweaks`,
    ],
  };

  const pool = byType[type] || [
    `update ${target} with ${files.length} change${files.length > 1 ? 's' : ''}`,
    `improve ${target}`,
    `modify ${shortList || target}`,
  ];

  const salt = (type + target + (index ?? 0)).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const idx = seededIndex(pool.length, variant, salt);
  return pool[idx];
}

// Deterministic index based on a seed and salt
function seededIndex(length: number, seed: number, salt: number): number {
  // Simple LCG-like mix, then mod length
  const mixed = (seed * 9301 + 49297 + salt * 233) % 233280;
  return length > 0 ? mixed % length : 0;
}
