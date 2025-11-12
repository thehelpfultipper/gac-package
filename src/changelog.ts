import { existsSync, readFileSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Config } from './config.js';
import { execa } from 'execa';

export interface ChangelogResult {
  path: string;
  written: boolean;
  preview?: string;
}

interface Options {
  config: Config;
  versionLabel?: string; // e.g., "v1.2.3" or "Unreleased"
  path?: string; // override path
  dryRun?: boolean;
  sinceRef?: string; // override since ref
  merge?: 'replace' | 'append';
}

interface CommitEntry {
  hash: string;
  date: string; // ISO
  subject: string;
  body: string;
}

export async function upsertChangelog(opts: Options): Promise<ChangelogResult> {
  const path = await resolveChangelogPath(opts.path);
  const existed = existsSync(path);

  const sinceRef = opts.sinceRef ?? (await getSinceRef(path, existed));
  const commits = await getCommitsSince(sinceRef);

  if (commits.length === 0) {
    const msg = sinceRef ? `No commits since ${sinceRef}` : 'No commits found';
    return { path, written: false, preview: msg };
  }

  const version = opts.versionLabel || (await inferVersionLabel());
  const newSection = await generateSectionMarkdown(commits, opts.config, version, sinceRef);

  if (opts.dryRun) {
    return { path, written: false, preview: newSection };
  }

  const content = existed
    ? mergeIntoExisting(readFileSync(path, 'utf-8'), newSection, version, opts.merge || 'replace')
    : buildNewFile(newSection);
  writeFileSync(path, content, 'utf-8');
  return { path, written: true };
}

async function resolveChangelogPath(override?: string): Promise<string> {
  if (override) return override;
  const candidates = [
    'CHANGELOG.md',
    'changelog.md',
    'Changelog.md',
    join('docs', 'CHANGELOG.md'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'CHANGELOG.md';
}

async function getSinceRef(changelogPath: string, existed: boolean): Promise<string | null> {
  // Prefer latest tag. If none, and file exists, try to parse last version heading.
  const lastTag = await getLastTag();
  if (lastTag) return lastTag;

  if (existed) {
    try {
      const txt = readFileSync(changelogPath, 'utf-8');
      const m = txt.match(/^##\s+\[?v?([0-9]+\.[0-9]+\.[0-9]+)[^\n]*$/m);
      if (m) return `v${m[1]}`;
    } catch {}
  }
  return null;
}

async function inferVersionLabel(): Promise<string> {
  // If HEAD is tagged, use that; otherwise use "Unreleased - YYYY-MM-DD"
  try {
    const { stdout } = await execa('git', ['describe', '--tags', '--exact-match']);
    if (stdout.trim()) return stdout.trim();
  } catch {}
  const today = new Date().toISOString().slice(0, 10);
  return `Unreleased - ${today}`;
}

function buildNewFile(section: string): string {
  const header = `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n`;
  return header + section.trim() + '\n';
}

function mergeIntoExisting(existing: string, newSection: string, version: string, mode: 'replace' | 'append' = 'replace'): string {
  // Replace the section matching the version heading (with optional date), else insert after top H1
  const lines = existing.split('\n');

  const escapeRegExp = (s: string) => s.replace(/[\-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const raw = (version || '').trim();
  const semverMatch = raw.match(/^\[?v?(\d+\.\d+\.\d+)\]?/i);
  let headingRe: RegExp;
  if (/^unreleased\b/i.test(raw)) {
    headingRe = new RegExp(`^##\\s+Unreleased\\b(?:\\s*-\\s*\\d{4}-\\d{2}-\\d{2})?\\s*$`, 'i');
  } else if (semverMatch) {
    const label = 'v' + semverMatch[1];
    headingRe = new RegExp(
      `^##\\s+\\[?${escapeRegExp(label)}\\]?\\b(?:\\s*-\\s*\\d{4}-\\d{2}-\\d{2})?\\s*$`,
      'i'
    );
  } else {
    // Fallback: match the raw string exactly
    headingRe = new RegExp(`^##\\s+${escapeRegExp(raw)}\\s*$`, 'i');
  }
  const isVersionHeading = (l: string) =>
    /^##\s+(?:\[?v?\d+\.\d+\.\d+\]?\b(?:\s*-\s*\d{4}-\d{2}-\d{2})?|Unreleased\b.*)$/i.test(l.trim());

  const startIdx = lines.findIndex(l => headingRe.test(l));
  if (startIdx !== -1) {
    // Find next version heading or EOF
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (isVersionHeading(lines[i])) { endIdx = i; break; }
    }

    if (mode === 'append') {
      const existingSection = lines.slice(startIdx, endIdx);
      const existingBullets = new Set(
        existingSection
          .filter(l => /^\s*-\s+/.test(l))
          .map(l => l.trim())
      );

      // Extract new body (skip heading + optional compare link and leading blank)
      const newLines = newSection.split('\n');
      let idx = 0;
      // Skip until first version heading
      while (idx < newLines.length && !/^##\s+/.test(newLines[idx])) idx++;
      if (idx < newLines.length) idx++; // skip the heading line
      // Optionally skip compare link line
      if (idx < newLines.length && /^\[.*\]\(.*\)\s*$/.test(newLines[idx])) idx++;
      // Skip a single blank line
      if (idx < newLines.length && newLines[idx].trim() === '') idx++;

      // Collect category blocks and bullets, filtering duplicates
      const outBlock: string[] = [];
      let currentHeading: string | null = null;
      let pendingBullets: string[] = [];
      const flush = () => {
        const newUnique = pendingBullets.filter(b => !existingBullets.has(b.trim()));
        if (newUnique.length > 0) {
          if (currentHeading) outBlock.push(currentHeading);
          for (const b of newUnique) outBlock.push(b);
          outBlock.push('');
        }
        pendingBullets = [];
      };
      for (; idx < newLines.length; idx++) {
        const line = newLines[idx];
        if (/^##\s+/.test(line)) break; // safety: next version
        if (/^###\s+/.test(line)) {
          flush();
          currentHeading = line.trim();
          continue;
        }
        if (/^\s*-\s+/.test(line)) {
          pendingBullets.push(line.trim());
          continue;
        }
        // Preserve blank lines only between blocks
        if (line.trim() === '') continue;
      }
      flush();

      if (outBlock.length === 0) {
        // Nothing new; return unchanged
        return existing;
      }

      const before = lines.slice(0, endIdx).join('\n');
      const after = lines.slice(endIdx).join('\n');
      const joiner = before.endsWith('\n') ? '' : '\n';
      return [before, joiner, outBlock.join('\n').replace(/\n+$/,''), '\n', after].join('');
    } else {
      const before = lines.slice(0, startIdx).join('\n');
      const after = lines.slice(endIdx).join('\n');
      return [before, newSection.trim(), after].filter(Boolean).join('\n');
    }
  }

  // Insert after first H1 if present
  const firstH1 = lines.findIndex(l => /^#\s+/.test(l));
  if (firstH1 !== -1) {
    const before = lines.slice(0, firstH1 + 1).join('\n');
    const after = lines.slice(firstH1 + 1).join('\n');
    return [before, '', newSection.trim(), after].join('\n');
  }

  // Default: prepend
  return newSection.trim() + '\n\n' + existing;
}

function toVersionHeading(version: string): string {
  return `## ${version}`;
}

async function getLastTag(): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['describe', '--tags', '--abbrev=0']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getCommitsSince(ref: string | null): Promise<CommitEntry[]> {
  const range = ref ? `${ref}..HEAD` : 'HEAD';
  const args = ['log', '--no-merges', '--date=iso', `--pretty=%H%x1f%ad%x1f%s%x1f%b%x1e`, range];
  const { stdout } = await execa('git', args);
  return stdout
    .split('\x1e')
    .map(s => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [hash, ad, s, b] = rec.split('\x1f');
      return { hash, date: ad, subject: s, body: (b || '').trim() } as CommitEntry;
    });
}

async function generateSectionMarkdown(commits: CommitEntry[], config: Config, versionLabel: string, sinceRef: string | null): Promise<string> {
  const heading = await buildVersionHeading(versionLabel, sinceRef);
  const categorized = categorizeCommits(commits);
  const heuristic = renderMarkdownFromCategories(categorized);

  // If engine is none, return heuristic
  if (config.engine === 'none') {
    return `${heading}\n\n${heuristic.trim()}\n`;
  }

  // Try engine; on failure, use heuristic
  try {
    const prompt = buildChangelogPrompt(commits, versionLabel);
    const llm = await completeWithEngine(config, prompt);
    const cleaned = llm.trim();
    // If model omitted a proper version heading, add it
    const firstLine = (cleaned.split('\n').find(l => l.trim() !== '') || '').trim();
    const hasVersionHeading = /^##\s+(?:\[?v?\d+\.\d+\.\d+\]?\b|Unreleased\b)/i.test(firstLine);
    const body = hasVersionHeading ? cleaned : `${heading}\n\n${cleaned}`;
    return body + '\n';
  } catch {
    return `${heading}\n\n${heuristic.trim()}\n`;
  }
}

function parseConventional(commit: CommitEntry): { type: string; scope?: string; subject: string; breaking: boolean } {
  const m = commit.subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (m) {
    const breaking = Boolean(m[3]) || /(^|\n)BREAKING CHANGES?:/i.test(commit.body);
    return { type: m[1].toLowerCase(), scope: m[2], subject: m[4], breaking };
  }
  const breaking = /(^|\n)BREAKING CHANGES?:/i.test(commit.body);
  return { type: 'other', subject: commit.subject, breaking };
}

function categorizeCommits(commits: CommitEntry[]): Map<string, Array<{ scope?: string; subject: string }>> {
  const map = new Map<string, Array<{ scope?: string; subject: string }>>();
  const push = (cat: string, item: { scope?: string; subject: string }) => {
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(item);
  };

  for (const c of commits) {
    const p = parseConventional(c);
    const item = { scope: p.scope, subject: sanitizeSubject(p.subject) };
    if (p.breaking) {
      push('Breaking Changes', item);
      continue;
    }
    switch (p.type) {
      case 'feat': push('Added', item); break;
      case 'fix': push('Fixed', item); break;
      case 'perf': push('Performance', item); break;
      case 'refactor': push('Changed', item); break;
      case 'docs': push('Documentation', item); break;
      case 'test': push('Tests', item); break;
      case 'build': push('Build', item); break;
      case 'ci': push('CI', item); break;
      case 'revert': push('Reverts', item); break;
      case 'chore': push('Chore', item); break;
      default: push('Other', item); break;
    }
  }
  return map;
}

function renderMarkdownFromCategories(map: Map<string, Array<{ scope?: string; subject: string }>>): string {
  // Order aligned with Keep a Changelog where possible
  const sectionsOrder = [
    'Breaking Changes',
    'Added',
    'Changed',
    'Deprecated',
    'Removed',
    'Fixed',
    'Security',
    'Performance',
    'Documentation',
    'Tests',
    'Build',
    'CI',
    'Reverts',
    'Chore',
    'Other',
  ];
  const parts: string[] = [];
  for (const key of sectionsOrder) {
    const items = map.get(key);
    if (!items || items.length === 0) continue;
    parts.push(`### ${key}`);
    for (const it of items) {
      const scope = it.scope ? `**${it.scope}**: ` : '';
      parts.push(`- ${scope}${it.subject}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

function buildChangelogPrompt(commits: CommitEntry[], versionLabel: string): string {
  const bullets = commits.slice(0, 200).map(c => `- ${c.subject}`).join('\n');
  return `Generate a concise Markdown changelog section for ${versionLabel} based on these Git commit subjects (most recent first):\n\n${bullets}\n\nRequirements:\n- Use headings like \"### Added\", \"### Fixed\", \"### Changed\" when applicable\n- Group related items, remove noise, deduplicate\n- Write short, clear bullets; no trailing punctuation\n- Do not include commit hashes or authors\n- Output only the section body (you may include subheadings), without extra commentary`;
}

async function completeWithEngine(config: Config, prompt: string): Promise<string> {
  switch (config.engine) {
    case 'ollama':
      return completeWithOllama(config.model, prompt);
    case 'openai':
      return completeWithOpenAI(config, prompt);
    case 'gemini':
      return completeWithGemini(config, prompt);
    case 'anthropic':
      throw new Error('Anthropic engine for changelog not implemented');
    default:
      throw new Error('No engine available');
  }
}

async function completeWithOllama(model: string, prompt: string): Promise<string> {
  const endpoint = 'http://127.0.0.1:11434/api/generate';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.5, top_p: 0.9 } }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data: any = await res.json();
  const text = data?.response || '';
  if (!text) throw new Error('Empty response from Ollama');
  return String(text);
}

async function completeWithOpenAI(config: Config, prompt: string): Promise<string> {
  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not found');
  const modelName = config.model && !config.model.includes(':') ? config.model : 'gpt-4o-mini';
  const body = {
    model: modelName,
    temperature: 0.5,
    top_p: 0.9,
    messages: [
      { role: 'system', content: 'You write crisp, well-structured changelog entries in Markdown.' },
      { role: 'user', content: prompt },
    ],
  } as const;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const data: any = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('Empty response from OpenAI');
  return text;
}

// Helpers for heading/date/compare links
async function buildVersionHeading(versionLabel: string, sinceRef: string | null): Promise<string> {
  // Normalize heading text and append ISO date for non-Unreleased
  const isUnreleased = /^unreleased/i.test(versionLabel);
  const today = new Date().toISOString().slice(0, 10);

  let label = versionLabel;
  // If label looks like a bare semver (1.2.3), prefix with v for consistency
  if (/^\d+\.\d+\.\d+$/.test(label)) label = `v${label}`;

  const baseHeading = isUnreleased ? `## Unreleased - ${today}` : `## ${label} - ${today}`;

  const compare = await getCompareLink(sinceRef, isUnreleased ? 'HEAD' : label);
  if (compare) {
    return `${baseHeading}\n\n[Compare changes](${compare})`;
  }
  return baseHeading;
}

async function getCompareLink(fromRef: string | null, toRef: string | null): Promise<string | null> {
  if (!fromRef || !toRef) return null;
  const remoteUrl = await getOriginHttpsUrl();
  if (!remoteUrl) return null;
  // GitHub/GitLab style compare URLs are similar
  if (/github\.com|gitlab\.com|bitbucket\.org/.test(remoteUrl)) {
    return `${remoteUrl}/compare/${encodeURIComponent(fromRef)}...${encodeURIComponent(toRef)}`;
  }
  return null;
}

async function getOriginHttpsUrl(): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin']);
    const raw = stdout.trim();
    if (!raw) return null;
    // git@github.com:owner/repo.git -> https://github.com/owner/repo
    const sshMatch = raw.match(/^git@([^:]+):(.+)\.git$/);
    if (sshMatch) {
      return `https://${sshMatch[1]}/${sshMatch[2]}`;
    }
    // https URL; strip .git suffix
    const httpsMatch = raw.match(/^https?:\/\/(.+)$/);
    if (httpsMatch) {
      const url = `https://${httpsMatch[1]}`.replace(/\.git$/, '');
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizeSubject(subject: string): string {
  // Remove trailing punctuation and leading verbs like "update" noise minimalism
  let s = subject.trim();
  s = s.replace(/[.;:!\s]+$/g, '');
  return s;
}

async function completeWithGemini(config: Config, prompt: string): Promise<string> {
  const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY not found');
  const modelName = config.model && !config.model.includes(':') ? config.model : 'gemini-1.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, topP: 0.9 } } as const;
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data: any = await res.json();
  const first = data?.candidates?.[0];
  let text = '';
  if (first?.content?.parts && Array.isArray(first.content.parts)) {
    text = first.content.parts.map((p: any) => p?.text || '').filter(Boolean).join('\n');
  } else if (first?.output_text) {
    text = first.output_text;
  }
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}
