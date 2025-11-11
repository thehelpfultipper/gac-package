import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';

export async function generateHeuristic(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  const { files } = changes;
  const variant = (config as any).regen ?? 0;

  // Split into code/docs groups
  const docsFiles = files.filter(f => isDocFile(f.path));
  const codeFiles = files.filter(f => !isDocFile(f.path));

  // Build filtered diffs
  const codeDiff = buildDiffForFiles(changes.diff, codeFiles);
  const docsDiff = buildDiffForFiles(changes.diff, docsFiles);

  // Derive type from code-only changes when present
  const baseFiles = codeFiles.length ? codeFiles : files;
  const baseDiff = codeFiles.length ? codeDiff : changes.diff;

  // Detect primary focus FIRST to inform type detection
  const primaryFocus = detectPrimaryFocus(baseFiles, baseDiff);
  
  // Use primary focus to inform type detection
  const type = detectChangeType(baseFiles, baseDiff, primaryFocus);
  
  // Extract scope from file paths
  const scope = detectScope(files);

  // Extract topics and categories
  const topics = extractTopics(codeDiff || changes.diff, baseFiles);
  const categories = categorizeFiles(baseFiles);

  // Derive docs topic and significance
  const docTopic = extractDocsTopic(docsDiff);
  const docWeight = docsFiles.reduce((s, f) => s + Math.max(1, (f.additions || 0) + (f.deletions || 0)), 0);
  const codeWeight = codeFiles.reduce((s, f) => s + Math.max(1, (f.additions || 0) + (f.deletions || 0)), 0);
  
  // Adjust threshold - architectural changes should dominate
  const isArchitecturalChange = primaryFocus.focus === 'engine-refactor' || 
    primaryFocus.focus === 'new-engine' || 
    primaryFocus.focus === 'multi-engine';
  
  const docsThreshold = isArchitecturalChange ? 0.6 : 0.4;
  const docsSignificant = docsFiles.some(f => /README\.md$/i.test(f.path)) && 
    (docWeight >= Math.ceil((codeWeight + docWeight) * docsThreshold));

  // Build descriptions with primary focus FIRST
  const descriptions = buildDescriptions(
    baseFiles, 
    type, 
    primaryFocus, 
    scope, 
    categories, 
    topics,
    variant
  );

  // Generate three diverse candidates
  const candidates: string[] = [];
  const isMixed = docsFiles.length > 0 && codeFiles.length > 0 && docsSignificant;

  // ALWAYS use primary focus description first (index 0)
  const primaryDesc = descriptions[0];
  
  // For regenerations, use alternative descriptions but still prioritize primary focus
  const selectedDesc = variant === 0 ? primaryDesc : descriptions[Math.min(variant, descriptions.length - 1)];

  if (config.style === 'conv' || config.style === 'mix') {
    if (isMixed) {
      const codeType = type;
      const codeScope = detectScope(codeFiles) || scope;
      const docsScope = docsFiles.some(f => /README\.md$/i.test(f.path)) ? 'readme' : '';
      const left = `${codeType}${codeScope ? `(${codeScope})` : ''}: ${selectedDesc.noun}`;
      const docsPhrase = docTopic || (docsScope === 'readme' ? 'README' : 'docs');
      const right = `docs${docsScope ? `(${docsScope})` : ''}: update ${docsPhrase}`;
      candidates.push(`${left}; ${right}`);
    } else {
      const scopePart = scope ? `(${scope})` : '';
      candidates.push(`${type}${scopePart}: ${selectedDesc.noun}`);
    }
  }

  if (config.style === 'plain' || config.style === 'mix') {
    if (isMixed) {
      const codeType = type;
      const docsScope = docsFiles.some(f => /README\.md$/i.test(f.path)) ? 'README' : 'docs';
      const verbCode = pickVerb(codeType, 'code', variant);
      const verbDocs = pickVerb('docs', 'docs', variant);
      const left = `${capitalizeFirst(verbCode)} ${selectedDesc.noun}`;
      const right = `${verbDocs} ${docTopic ? (docsScope === 'README' ? `README ${docTopic}` : docTopic) : docsScope}`;
      candidates.push(`${left} and ${right}`);
    } else {
      candidates.push(capitalizeFirst(`${selectedDesc.verb} ${selectedDesc.noun}`));
    }
  }

  if (config.style === 'gitmoji' || config.style === 'mix') {
    const emoji = getEmoji(type);
    if (isMixed) {
      const codeType = type;
      const docsScope = docsFiles.some(f => /README\.md$/i.test(f.path)) ? 'README' : 'docs';
      const verbCode = pickVerb(codeType, 'code', variant);
      const left = `${getEmoji(codeType)} ${verbCode} ${selectedDesc.noun}`;
      const right = `📝 ${pickVerb('docs', 'docs', variant)} ${docTopic ? (docsScope === 'README' ? `README ${docTopic}` : docTopic) : docsScope}`;
      candidates.push(`${left}; ${right}`);
    } else {
      const scopePart = scope ? `${scope}: ` : '';
      candidates.push(`${emoji} ${scopePart}${selectedDesc.verb} ${selectedDesc.noun}`);
    }
  }

  // Generate genuinely different alternatives from OTHER descriptions
  const usedDescs = new Set([variant === 0 ? 0 : Math.min(variant, descriptions.length - 1)]);
  let altIndex = 1;
  
  while (candidates.length < 3 && altIndex < descriptions.length) {
    if (usedDescs.has(altIndex)) {
      altIndex++;
      continue;
    }
    usedDescs.add(altIndex);
    
    const altDesc = descriptions[altIndex];
    const alt = config.style === 'gitmoji' 
      ? `${getEmoji(type)} ${scope ? `${scope}: ` : ''}${altDesc.verb} ${altDesc.noun}`
      : capitalizeFirst(`${altDesc.verb} ${altDesc.noun}`);
    
    if (!candidates.includes(alt)) {
      candidates.push(alt);
    }
    altIndex++;
  }

  // Final fallback if still need more
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

function detectPrimaryFocus(files: any[], diff: string): {
  focus: 'new-engine' | 'multi-engine' | 'engine-refactor' | 'scope-specific' | 'multi-category' | 'single-file' | 'generic';
  detail: string;
  weight: number;
} {
  if (files.length === 0) return { focus: 'generic', detail: '', weight: 1 };

  // Collect engine-related files
  const newEngines = files.filter(f => 
    f.status === 'A' && /\/engines\/[^/]+\.(ts|js)$/.test(f.path) && !/heuristic\./.test(f.path)
  );
  const newShared = files.filter(f => 
    f.status === 'A' && /\/engines\/shared\.(ts|js)$/.test(f.path)
  );
  const modifiedEngines = files.filter(f => 
    f.status === 'M' && /\/engines\/[^/]+\.(ts|js)$/.test(f.path) && !/heuristic\.|shared\./i.test(f.path)
  );
  const modifiedHeuristic = files.some(f => 
    f.status === 'M' && /\/engines\/heuristic\.(ts|js)$/.test(f.path)
  );

  // Pattern: New engine(s) + shared utilities + multiple modifications = ARCHITECTURE REFACTOR
  if ((newEngines.length > 0 || newShared.length > 0) && modifiedEngines.length >= 2) {
    const engineNames = newEngines
      .map(f => f.path.split('/').pop()?.replace(/\.[^.]+$/, '') || '')
      .filter(Boolean)
      .map(n => n.charAt(0).toUpperCase() + n.slice(1));
    
    // Build comprehensive detail
    const parts = [];
    if (engineNames.length > 0) {
      parts.push(`${engineNames.join(' and ')} integration`);
    }
    if (newShared.length > 0) {
      parts.push('shared utilities');
    }
    
    const detail = parts.length > 1 
      ? `engine architecture with ${parts.join(' and ')}`
      : `engine architecture with ${parts[0] || 'shared utilities'}`;
    
    return { 
      focus: 'engine-refactor', 
      detail,
      weight: 10
    };
  }

  // Pattern: New engine(s) + modified engines (no shared) = extending engine support
  if (newEngines.length > 0 && modifiedEngines.length >= 1) {
    const engineNames = newEngines
      .map(f => f.path.split('/').pop()?.replace(/\.[^.]+$/, '') || '')
      .filter(Boolean)
      .map(n => n.charAt(0).toUpperCase() + n.slice(1));
    
    if (engineNames.length === 1) {
      return { 
        focus: 'new-engine', 
        detail: `${engineNames[0]} engine support`,
        weight: 8
      };
    } else {
      return { 
        focus: 'new-engine', 
        detail: `${engineNames.slice(0, 2).join(' and ')} engine support`,
        weight: 8
      };
    }
  }

  // Pattern: Single new engine, no other engine changes
  if (newEngines.length === 1 && modifiedEngines.length === 0) {
    const name = newEngines[0].path.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    return { 
      focus: 'new-engine', 
      detail: `${capitalized} engine`,
      weight: 7
    };
  }

  // Pattern: Multiple new engines
  if (newEngines.length > 1) {
    const names = newEngines
      .map(f => f.path.split('/').pop()?.replace(/\.[^.]+$/, '') || '')
      .filter(Boolean)
      .map(n => n.charAt(0).toUpperCase() + n.slice(1));
    return { 
      focus: 'new-engine', 
      detail: `${names.slice(0, 2).join(' and ')} engines`,
      weight: 7
    };
  }

  // Pattern: Multiple engine modifications (no new engines)
  if (modifiedEngines.length >= 3) {
    return { 
      focus: 'multi-engine', 
      detail: 'multiple engines',
      weight: 6
    };
  }

  // Pattern: Shared utilities modified with engines = refactor
  if (newShared.length > 0 && (modifiedEngines.length >= 2 || modifiedHeuristic)) {
    return { 
      focus: 'engine-refactor', 
      detail: 'engine architecture',
      weight: 9
    };
  }

  // Single file change
  if (files.length === 1) {
    const fileName = files[0].path.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
    return { 
      focus: 'single-file', 
      detail: fileName,
      weight: 3
    };
  }

  // Check for scope-specific changes
  const scope = detectScope(files);
  if (scope) {
    const scopeFiles = files.filter(f => {
      const normalized = f.path.replace(/\\/g, '/').toLowerCase();
      return normalized.includes(scope.toLowerCase()) || normalized.includes(`/${scope}/`);
    });
    if (scopeFiles.length >= files.length * 0.6) {
      return { 
        focus: 'scope-specific', 
        detail: scope,
        weight: 5
      };
    }
  }

  // Multi-category change
  const cats = categorizeFiles(files);
  if (cats.size >= 2) {
    return { 
      focus: 'multi-category', 
      detail: Array.from(cats.keys()).slice(0, 3).join(','),
      weight: 4
    };
  }

  return { focus: 'generic', detail: '', weight: 2 };
}

function buildDescriptions(
  files: any[], 
  type: string, 
  primaryFocus: ReturnType<typeof detectPrimaryFocus>,
  scope: string,
  categories: Map<string, number>,
  topics: string[],
  variant: number
): Array<{ verb: string; noun: string }> {
  const descriptions: Array<{ verb: string; noun: string }> = [];
  
  // ALWAYS put primary focus FIRST (index 0)
  const primaryVerb = getVerbForFocus(primaryFocus.focus, type, 0);
  
  switch (primaryFocus.focus) {
    case 'new-engine':
      descriptions.push({
        verb: primaryVerb,
        noun: primaryFocus.detail
      });
      break;
    case 'multi-engine':
      descriptions.push({
        verb: primaryVerb,
        noun: primaryFocus.detail
      });
      break;
    case 'engine-refactor':
      descriptions.push({
        verb: 'refactor',
        noun: primaryFocus.detail
      });
      break;
    case 'single-file':
      descriptions.push({
        verb: primaryVerb,
        noun: primaryFocus.detail
      });
      break;
    case 'scope-specific':
      const catNoun = buildCategoryNoun(files);
      descriptions.push({
        verb: primaryVerb,
        noun: catNoun || `${primaryFocus.detail} implementation`
      });
      break;
    case 'multi-category':
      descriptions.push({
        verb: primaryVerb,
        noun: buildCategoryNoun(files) || 'multiple components'
      });
      break;
    default:
      descriptions.push({
        verb: primaryVerb,
        noun: buildSubject(files, type, false)
      });
  }

  // Alternative 2: Supporting changes perspective (for architectural refactors)
  if (primaryFocus.focus === 'engine-refactor' || primaryFocus.focus === 'new-engine') {
    const hasConfigChanges = files.some(f => /config\.(ts|js|json)/.test(f.path));
    const hasCLIChanges = files.some(f => /cli\.(ts|js)/.test(f.path));
    const hasGeneratorChanges = files.some(f => /generator\.(ts|js)/.test(f.path));
    
    const supportingParts = [];
    if (hasConfigChanges) supportingParts.push('configuration');
    if (hasCLIChanges) supportingParts.push('CLI');
    if (hasGeneratorChanges) supportingParts.push('generator');
    
    if (supportingParts.length > 0) {
      // Extract engine name from detail (e.g., "engine architecture with Gemini integration" -> "Gemini")
      const engineMatch = primaryFocus.detail.match(/\b([A-Z][a-z]+)\s+(engine|integration)/);
      const engineName = engineMatch ? engineMatch[1] : 'engine';
      
      const supportingDesc = supportingParts.length === 1 
        ? supportingParts[0]
        : supportingParts.length === 2
        ? supportingParts.join(' and ')
        : `${supportingParts.slice(0, -1).join(', ')}, and ${supportingParts[supportingParts.length - 1]}`;
      
      descriptions.push({
        verb: primaryVerb,
        noun: `${engineName} with ${supportingDesc} updates`
      });
    }
  }
  
  // Alternative 3: Multi-engine perspective (which engines were affected)
  if (descriptions.length < 3 && (primaryFocus.focus === 'engine-refactor' || primaryFocus.focus === 'multi-engine')) {
    const modifiedEngineNames = files
      .filter(f => f.status === 'M' && /\/engines\/[^/]+\.(ts|js)$/.test(f.path) && !/heuristic\.|shared\./i.test(f.path))
      .map(f => {
        const name = f.path.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
        return name.charAt(0).toUpperCase() + name.slice(1);
      })
      .filter(Boolean)
      .slice(0, 2);
    
    if (modifiedEngineNames.length > 0) {
      const engineList = modifiedEngineNames.length === 1
        ? `${modifiedEngineNames[0]} engine`
        : `${modifiedEngineNames.join(' and ')} engines`;
      
      descriptions.push({
        verb: getDefaultVerb(type, variant),
        noun: engineList
      });
    }
  }

  // Alternative 4: Category-based perspective (avoid generic terms)
  if (categories.size >= 2 && primaryFocus.focus !== 'multi-category' && descriptions.length < 4) {
    const topCategories = Array.from(categories.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k]) => prettifyCategory(k, files))
      .filter(cat => {
        const lower = cat.toLowerCase();
        // Remove generic "code" if we have more specific categories
        return lower !== 'code' && lower !== 'files';
      });
    
    if (topCategories.length >= 2) {
      descriptions.push({
        verb: getDefaultVerb(type, variant),
        noun: topCategories.join(' and ')
      });
    }
  }

  // Alternative 5: Scope-based (where the change is)
  if (scope && primaryFocus.focus !== 'scope-specific' && descriptions.length < 5) {
    const topCat = Array.from(categories.entries()).sort((a, b) => b[1] - a[1])[0];
    if (topCat) {
      const catName = prettifyCategory(topCat[0], files);
      // Avoid duplicate like "engine engines"
      if (catName.toLowerCase() !== scope.toLowerCase()) {
        descriptions.push({
          verb: getDefaultVerb(type, variant),
          noun: `${scope} ${catName}`
        });
      }
    }
  }

  // Ensure we have at least 3 unique descriptions
  if (descriptions.length < 3) {
    const fallback = buildSubject(files, type, false);
    // Only add if genuinely different
    const isDuplicate = descriptions.some(d => 
      d.noun.toLowerCase() === fallback.toLowerCase() ||
      d.noun.toLowerCase().includes(fallback.toLowerCase()) ||
      fallback.toLowerCase().includes(d.noun.toLowerCase())
    );
    
    if (!isDuplicate) {
      descriptions.push({
        verb: getDefaultVerb(type, variant),
        noun: fallback
      });
    }
  }

  return descriptions;
}

function getVerbForFocus(focus: string, type: string, variant: number): string {
  if (focus === 'engine-refactor') return 'refactor';
  if (focus === 'new-engine') return type === 'feat' ? 'add' : 'implement';
  if (focus === 'multi-engine') return 'update';
  return getDefaultVerb(type, variant);
}

function prettifyCategory(category: string, files: any[]): string {
  if (category === 'engine') {
    const engineNoun = detectEngineNoun(files);
    return engineNoun || 'engines';
  }
  if (category === 'cli') return 'CLI';
  if (category === 'api' || category === 'API') return 'API';
  if (category === 'ui') return 'UI';
  if (category === 'config') return 'configuration';
  return category;
}

function detectChangeType(files: any[], diff: string, primaryFocus?: ReturnType<typeof detectPrimaryFocus>): string {
  const allDocs = files.every(f => /\.(md|txt|rst|adoc)$/i.test(f.path));
  if (allDocs) return 'docs';

  // If primary focus is architectural refactor, type should be refactor
  if (primaryFocus && primaryFocus.focus === 'engine-refactor') {
    return 'refactor';
  }

  const addedCode = files.some(f => f.status === 'A' && /\.(tsx?|jsx?|py|go|rs|java|cs|rb|php)$/.test(f.path));
  const hasNewKeywords = /\bnew\s+(feature|component|function|class|endpoint|route|api)\b/i.test(diff) ||
    /\badd(ed|ing)?\s+(feature|component|function|class)\b/i.test(diff);

  // If primary focus is new engine, it's a feature
  if (primaryFocus && (primaryFocus.focus === 'new-engine' || primaryFocus.focus === 'multi-engine')) {
    return 'feat';
  }

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
    /\b(deps|dependency|dependencies|version|bump|upgrade|lockfile)\b/i.test(diff);

  if (addedCode) return 'feat';
  if (fixStrong && (fixWeakCount >= 1 || isTestChange)) return 'fix';
  if (isTestChange) return 'test';
  if (isRefactor) return 'refactor';
  if (isStyle) return 'style';
  if (isChore) return 'chore';

  return files[0]?.status === 'A' ? 'feat' : 'chore';
}

function detectScope(files: any[]): string {
  if (files.length === 0) return '';

  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const paths = files.map(f => normalize(f.path));
  const weights = files.map(f => Math.max(1, (f.additions || 0) + (f.deletions || 0)));

  const domains: Record<string, RegExp> = {
    engine: /\b(engine|engines|heuristic|ollama|openai|gemini|anthropic|claude)\b/,
    cli: /\b(cli|command|bin)\b/,
    api: /\b(api|endpoint|route|controller)\b/,
    auth: /\b(auth|login|session|token|oauth|jwt)\b/,
    db: /\b(database|db|model|schema|migration)\b/,
    config: /\b(config|setting|env)\b/,
    build: /\b(build|webpack|vite|rollup|babel)\b/,
    test: /\b(test|spec|__tests__)\b/,
    ui: /\b(ui|component|view|page|layout)\b/,
    docs: /\b(readme|docs|changelog|contributing)\b|\.(md|rst|adoc)\b/,
  };

  const counts = Object.keys(domains).reduce((acc, key) => {
    const re = domains[key];
    let total = 0;
    for (let i = 0; i < paths.length; i++) {
      if (re.test(paths[i])) total += weights[i];
    }
    acc[key] = total;
    return acc;
  }, {} as Record<string, number>);

  const codeMask = paths.map(p => !/\.(md|txt|rst|adoc)$/i.test(p));
  const anyCode = codeMask.some(Boolean);
  if (anyCode) counts.docs = 0;

  const order = ['engine', 'cli', 'api', 'auth', 'db', 'config', 'build', 'test', 'ui', 'docs'];
  const best = Object.keys(counts)
    .filter(k => counts[k] > 0)
    .sort((a, b) => counts[b] - counts[a] || order.indexOf(a) - order.indexOf(b))[0];
  
  if (best) {
    const totalCodeWeight = paths.reduce((sum, p, i) => sum + (codeMask[i] ? weights[i] : 0), 0) || weights.reduce((a,b)=>a+b,0);
    const proportion = counts[best] / Math.max(1, totalCodeWeight);
    if (proportion >= 0.5 || counts[best] >= 2) return best;
  }

  if (files.length === 1) {
    const parts = normalize(files[0].path).split('/').slice(0, -1);
    const meaningful = parts.filter((p: string) => !['src', 'lib', 'dist', 'build', '.', 'node_modules', 'packages', 'apps', 'public', 'assets', 'scripts'].includes(p));
    const scope = meaningful.pop();
    return scope && scope.length <= 15 ? scope : '';
  }

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

function extractTopics(diff: string, files?: any[]): string[] {
  if (!diff) return [];
  const topics = new Set<string>();

  const addIf = (re: RegExp, label: string) => { if (re.test(diff)) topics.add(label); };

  addIf(/\bdetectScope\b/, 'scope detection');
  addIf(/\bcategorizeFiles\b/, 'file categorization');
  addIf(/\bdetectChangeType\b/, 'type detection');
  addIf(/\bbuildSubject\b/, 'subject generation');
  addIf(/\bgenerateAlternative\b/, 'alternative generation');
  addIf(/\bgetAction\b/, 'action selection');
  addIf(/\bscope\b/i, 'scope handling');
  addIf(/\bcategor(y|ies|ization)\b/i, 'categorization');
  addIf(/\bheuristic\b/i, 'heuristic logic');
  addIf(/\bengine\b/i, 'engine integration');
  addIf(/\bconfig\b/i, 'configuration');
  addIf(/\bprovider\b/i, 'provider integration');
  addIf(/\bapi\s+key\b/i, 'API credentials');
  addIf(/\bauthenticat/i, 'authentication');

  return Array.from(topics).slice(0, 4);
}

function detectEngineNoun(files: any[]): string {
  if (!files || files.length === 0) return '';
  const engineFiles = files.filter(f => /\/engines\//.test(String(f.path || '')));
  if (engineFiles.length === 0) return '';

  const added = engineFiles.filter(f => f.status === 'A');
  const target = added.length > 0 ? added : engineFiles;

  const names = target
    .map(f => String(f.path || '').replace(/\\/g, '/'))
    .map(p => p.split('/').pop() || '')
    .map(n => n.replace(/\.[^.]+$/, ''))
    .filter(n => !/^shared|heuristic$/i.test(n))
    .map(n => n.charAt(0).toUpperCase() + n.slice(1));

  if (names.length === 0) return 'engines';
  if (names.length === 1) return `${names[0]} engine`;
  if (names.length === 2) return `${names.join(' and ')} engines`;
  return `${names.slice(0, 2).join(', ')} and other engines`;
}

function buildCategoryNoun(files: any[]): string {
  if (!files || files.length === 0) return '';
  const cats = categorizeFiles(files);
  if (cats.size === 0) return '';
  
  const entries = Array.from(cats.entries()).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, Math.min(3, entries.length)).map(([k]) => k);

  const parts = top.map(k => prettifyCategory(k, files)).filter(Boolean);
  
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function extractDocsTopic(diff: string): string {
  if (!diff) return '';
  const lines = diff.split('\n');
  const text = diff.toLowerCase();

  const headingMatch = lines.find(l => /^[+].*#+\s+/.test(l));
  if (headingMatch) {
    const h = headingMatch.replace(/^\+\s*/, '').replace(/^#+\s+/, '').toLowerCase();
    if (/install|setup|getting\s+started/.test(h)) return 'installation';
    if (/usage|run|command/.test(h)) return 'usage';
    if (/example|demo|sample/.test(h)) return 'examples';
    if (/config|configuration|env/.test(h)) return 'configuration';
    if (/api|reference|endpoint/.test(h)) return 'API reference';
    if (/troubleshooting|faq/.test(h)) return 'troubleshooting';
    if (/contribut/.test(h)) return 'contributing';
    if (/changelog|release/.test(h)) return 'changelog';
  }

  if (/\binstall|setup\b/.test(text)) return 'installation';
  if (/\busage|command\b/.test(text)) return 'usage';
  if (/\bexample|sample\b/.test(text)) return 'examples';
  if (/\bconfig|configuration|env\b/.test(text)) return 'configuration';
  if (/\bapi\b/.test(text)) return 'API reference';
  if (/\bchangelog|release\b/.test(text)) return 'changelog';
  if (/\bcontribut/.test(text)) return 'contributing';

  const addedLinks = lines.filter(l => /^\+/.test(l) && /https?:\/\//i.test(l)).length;
  const removedLinks = lines.filter(l => /^-/.test(l) && /https?:\/\//i.test(l)).length;
  if (addedLinks + removedLinks > 0) return 'links';

  const smallTextOnly = lines.every(l => !/^diff --git /.test(l)) && lines.filter(l => /^[+-]/.test(l)).length < 10;
  if (smallTextOnly) return 'typos';

  return '';
}

function pickVerb(type: string, domain: 'code' | 'docs', variant: number): string {
  const pools: Record<string, string[]> = {
    docs: ['clarify', 'update', 'improve', 'refine'],
    refactor: ['adjust', 'refactor', 'simplify', 'restructure'],
    chore: ['refine', 'update', 'tune', 'maintain'],
    feat: ['introduce', 'add', 'implement'],
    fix: ['fix', 'address', 'resolve', 'correct'],
    perf: ['optimize', 'improve', 'enhance'],
    default: ['update', 'improve', 'modify'],
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
    const fileName = normPath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'file';
    const action = getAction(file.status, type);

    if (file.summary) {
      const ids = file.summary.split(',')[0].trim();
      return includeVerb ? `${action} ${ids} in ${fileName}` : `${ids} in ${fileName}`;
    }

    return includeVerb ? `${action} ${fileName}` : fileName;
  }

  const action = getAction(files[0]?.status || 'M', type);
  const categories = categorizeFiles(files);

  if (categories.size === 1) {
    const [category] = categories.keys();
    const engineNoun = category === 'engine' ? detectEngineNoun(files) : '';
    const noun = engineNoun || category;
    return includeVerb ? `${action} ${noun} across ${files.length} files` : `${noun} across ${files.length} files`;
  }

  const topEntries = Array.from(categories.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  const topCategories = topEntries.map(([cat]) => cat);

  if (topCategories.length === 2) {
    const engineNoun = topCategories.includes('engine') ? detectEngineNoun(files) : '';
    const first = topCategories[0] === 'engine' ? (engineNoun || 'engines') : topCategories[0];
    const second = topCategories[1] === 'engine' ? (engineNoun || 'engines') : topCategories[1];
    return includeVerb ? `${action} ${first} and ${second}` : `${first} and ${second}`;
  }

  return includeVerb ? `${action} ${files.length} files` : `${files.length} files`;
}

function getAction(status: string, type: string, fileCount: number = 1): string {
  if (status === 'A') return type === 'feat' ? 'add' : 'create';
  if (status === 'D') return 'remove';
  if (status === 'R') return 'rename';

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
    const weight = Math.max(1, (file.additions || 0) + (file.deletions || 0));

    // Weight new files MORE heavily (architectural significance)
    const isNew = file.status === 'A';
    const effectiveWeight = isNew ? weight * 2.0 : weight;

    if (/\.(tsx|jsx)$/.test(path)) {
      category = 'components';
    } else if (/\.(ts|js)$/.test(path)) {
      if (path.includes('/engines/')) category = 'engine';
      else if (path.includes('/cli')) category = 'cli';
      else category = 'code';
    } else if (/\.(css|scss|less)$/.test(path)) {
      category = 'styles';
    } else if (/\.test\.|\.spec\.|__tests__/.test(path)) {
      category = 'tests';
    } else if (/\.(md|txt|rst|adoc)$/.test(path)) {
      category = 'docs';
    } else if (/api|route|endpoint/.test(path)) {
      category = 'API';
    } else if (/config|settings/.test(path)) {
      category = 'config';
    } else if (/\.py$/.test(path)) {
      category = 'modules';
    }

    categories.set(category, (categories.get(category) || 0) + effectiveWeight);
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

function seededIndex(length: number, seed: number, salt: number): number {
  const mixed = (seed * 9301 + 49297 + salt * 233) % 233280;
  return length > 0 ? mixed % length : 0;
}

function buildDiffForFiles(diff: string, files: any[]): string {
  if (!diff || files.length === 0) return '';
  const wanted = new Set(
    files.map(f => String(f.path || '')).filter(Boolean).map(p => p.replace(/\\/g, '/'))
  );
  const lines = diff.split('\n');
  const out: string[] = [];
  let include = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      const a = m[1].replace(/\\/g, '/');
      const b = m[2].replace(/\\/g, '/');
      include = wanted.has(a) || wanted.has(b);
    }
    if (include) out.push(line);
  }
  return out.join('\n').trim();
}