import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';

export async function generateHeuristic(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  const { files } = changes;
  
  // Analyze change patterns
  const stats = {
    added: files.filter(f => f.status === 'A').length,
    modified: files.filter(f => f.status === 'M').length,
    deleted: files.filter(f => f.status === 'D').length,
    renamed: files.filter(f => f.status === 'R').length,
  };

  const totalChanges = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  
  // Detect change type
  const type = detectChangeType(files, changes.diff);
  
  // Extract scope from file paths
  const scope = detectScope(files);
  
  // Build subject from files and summaries
  const subject = buildSubject(files, type, totalChanges);
  
  // Generate three diverse candidates
  const candidates: string[] = [];

  if (config.style === 'conv' || config.style === 'mix') {
    // Conventional Commits format
    const scopePart = scope ? `(${scope})` : '';
    candidates.push(`${type}${scopePart}: ${subject}`);
  }

  if (config.style === 'plain' || config.style === 'mix') {
    // Plain imperative
    candidates.push(capitalizeFirst(subject));
  }

  if (config.style === 'gitmoji' || config.style === 'mix') {
    // Gitmoji style
    const emoji = getEmoji(type);
    const scopePart = scope ? `${scope}: ` : '';
    candidates.push(`${emoji} ${scopePart}${subject}`);
  }

  // Fill remaining slots if needed
  while (candidates.length < 3) {
    const alt = generateAlternative(files, type, scope, candidates.length);
    if (!candidates.includes(alt)) {
      candidates.push(alt);
    } else {
      break;
    }
  }

  return candidates.slice(0, 3);
}

function detectChangeType(files: any[], diff: string): string {
  const patterns = {
    feat: [
      /\bnew\s+(feature|component|function|class|endpoint|route|api)/i,
      /\badd(ed|ing)?\s+(feature|component|function|class)/i,
      /export\s+(?:default\s+)?(?:function|class|const)/,
      files.some(f => f.status === 'A' && /\.(tsx?|jsx?|py|go|rs)$/.test(f.path)),
    ],
    fix: [
      /\b(fix|bug|issue|error|crash|patch|resolve)/i,
      /\b(throw|catch|try|error|exception)/i,
      /\b(null|undefined).*check/i,
      /test.*fail/i,
    ],
    docs: [
      files.every(f => /\.(md|txt|rst|adoc)$/.test(f.path)),
      /\bREADME/i,
      /\bdocumentation/i,
    ],
    test: [
      files.some(f => /\.test\.|_test\.|spec\.|__tests__/.test(f.path)),
      /\b(test|spec|jest|mocha|pytest)/i,
    ],
    refactor: [
      /\b(refactor|restructure|reorganize|cleanup|simplify)/i,
      files.every(f => f.status === 'M' && f.additions > 0 && f.deletions > 0),
    ],
    style: [
      files.some(f => /\.(css|scss|less|styl)$/.test(f.path)),
      /\b(style|format|prettier|eslint|lint)/i,
    ],
    chore: [
      files.some(f => /(package\.json|package-lock|yarn\.lock|Cargo\.toml|go\.mod)/.test(f.path)),
      /\b(deps|dependencies|version|config)/i,
    ],
  };

  for (const [type, checks] of Object.entries(patterns)) {
    const matches = checks.filter(check => {
      if (typeof check === 'boolean') return check;
      if (check instanceof RegExp) return check.test(diff);
      return false;
    });
    
    if (matches.length >= 2 || (type === 'feat' && matches.length >= 1)) {
      return type;
    }
  }

  return files[0]?.status === 'A' ? 'feat' : 'chore';
}

function detectScope(files: any[]): string {
  if (files.length === 0) return '';
  
  // Find common parent directory
  const paths = files.map(f => f.path);
  
  if (paths.length === 1) {
    const parts = paths[0].split('/');
    return parts.length > 1 ? parts[parts.length - 2] : '';
  }

  // Find longest common prefix
  const commonParts: string[] = [];
  const allParts = paths.map(p => p.split('/'));
  
  for (let i = 0; i < Math.min(...allParts.map(p => p.length)); i++) {
    const part = allParts[0][i];
    if (allParts.every(parts => parts[i] === part)) {
      commonParts.push(part);
    } else {
      break;
    }
  }

  // Use last meaningful part (skip 'src', 'lib', etc.)
  const scope = commonParts.filter(p => !['src', 'lib', 'dist', 'build'].includes(p)).pop();
  return scope && scope.length <= 15 ? scope : '';
}

function buildSubject(files: any[], type: string, totalChanges: number): string {
  if (files.length === 1) {
    const file = files[0];
    const fileName = file.path.split('/').pop()?.replace(/\\.[^.]+$/, '');
    const action = getAction(file.status, type);
    
    if (file.summary) {
      const ids = file.summary.split(',')[0].trim();
      return `${action} ${ids} in ${fileName}`;
    }
    
    return `${action} ${fileName}`;
  }

  // Multiple files
  const action = getAction(files[0].status, type);
  const categories = categorizeFiles(files);
  
  if (categories.size === 1) {
    const [category] = categories.keys();
    return `${action} ${category} across ${files.length} files`;
  }

  const topCategories = Array.from(categories.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([cat]) => cat);

  if (topCategories.length === 2) {
    return `${action} ${topCategories[0]} and ${topCategories[1]}`;
  }

  return `${action} ${files.length} files`;
}

function getAction(status: string, type: string): string {
  if (status === 'A') return type === 'feat' ? 'add' : 'create';
  if (status === 'D') return 'remove';
  if (status === 'R') return 'rename';
  
  // Modified
  const actions: Record<string, string> = {
    feat: 'add',
    fix: 'fix',
    refactor: 'refactor',
    docs: 'update',
    test: 'update',
    style: 'style',
    chore: 'update',
  };
  
  return actions[type] || 'update';
}

function categorizeFiles(files: any[]): Map<string, number> {
  const categories = new Map<string, number>();
  
  for (const file of files) {
    let category = 'files';
    
    if (/\\.(tsx?|jsx?)$/.test(file.path)) category = 'components';
    else if (/\\.(css|scss|less)$/.test(file.path)) category = 'styles';
    else if (/\\.test\\.|\\.spec\\.|__tests__/.test(file.path)) category = 'tests';
    else if (/\\.(md|txt)$/.test(file.path)) category = 'docs';
    else if (/api|route|endpoint/.test(file.path)) category = 'API';
    else if (/config|settings/.test(file.path)) category = 'config';
    else if (/\\.py$/.test(file.path)) category = 'modules';
    
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
  };
  
  return emojis[type] || '🔨';
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function generateAlternative(files: any[], type: string, scope: string, index: number): string {
  const alternatives = [
    `update ${scope || 'code'} with ${files.length} change${files.length > 1 ? 's' : ''}`,
    `improve ${scope || 'implementation'}`,
    `modify ${files.map(f => f.path.split('/').pop()).slice(0, 2).join(' and ')}`,
  ];
  
  return alternatives[index % alternatives.length];
}