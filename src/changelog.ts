import { existsSync, readFileSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Config } from './config.js';
import { execa } from 'execa';
import { callLlmApi } from './engines/llm-client.js';

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
    ? mergeIntoExisting(readFileSync(path, 'utf-8'), newSection, version)
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
    } catch { }
  }
  return null;
}

async function inferVersionLabel(): Promise<string> {
  // If HEAD is tagged, use that; otherwise use "Unreleased - YYYY-MM-DD"
  try {
    const { stdout } = await execa('git', ['describe', '--tags', '--exact-match']);
    if (stdout.trim()) return stdout.trim();
  } catch { }
  const today = new Date().toISOString().slice(0, 10);
  return `Unreleased - ${today}`;
}

function buildNewFile(section: string): string {
  const header = `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n`;
  return header + section.trim() + '\n';
}

function mergeIntoExisting(existing: string, newSection: string, version: string): string {
  // Replace the section matching the version heading (with optional date), else insert after top H1
  const lines = existing.split('\n');

  const escapeRegExp = (s: string) => s.replace(/[\-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const raw = (version || '').trim();
  const semverMatch = raw.match(/^\[?v?(\d+\.\d+\.\d+)\]?/i);
  let headingRe: RegExp;
  if (/^unreleased\b/i.test(raw)) {
    headingRe = new RegExp(`^##\\s+Unreleased\\b(?:\\s*-\\s*\\d{4}-\\d{2}-\\d{2})?\\s*$`, 'i');
  } else if (semverMatch) {
    const versionDigits = semverMatch[1];
    headingRe = new RegExp(
      `^##\\s+\\[?v?${escapeRegExp(versionDigits)}\\]?\\b(?:\\s*-\\s*\\d{4}-\\d{2}-\\d{2})?\\s*$`,
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
    const before = lines.slice(0, startIdx).join('\n');
    const after = lines.slice(endIdx).join('\n');
    return [before, newSection.trim(), after].filter(Boolean).join('\n');
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

// Infer a conventional commit type from a non-conventional commit subject
function inferCategoryFromSubject(subject: string): string {
  const s = subject.toLowerCase();
  if (/\b(fix|bug|patch|resolve|correct)\b/i.test(s)) return 'Fixed';
  if (/\b(feat|feature|add|implement|introduce)\b/i.test(s)) return 'Added';
  if (/\b(refactor|simplify|restructure|cleanup)\b/i.test(s)) return 'Changed';
  if (/\b(perf|performance|optimize)\b/i.test(s)) return 'Performance';
  if (/\b(docs|readme|documentation)\b/i.test(s)) return 'Documentation';
  if (/\b(test|spec)\b/i.test(s)) return 'Tests';
  if (/\b(build|ci|pipeline)\b/i.test(s)) return 'Build';
  if (/\b(revert)\b/i.test(s)) return 'Reverts';
  return 'Other'; // Fallback
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
    let category: string;
    switch (p.type) {
      case 'feat': category = 'Added'; break;
      case 'fix': category = 'Fixed'; break;
      case 'perf': category = 'Performance'; break;
      case 'refactor': category = 'Changed'; break;
      case 'docs': category = 'Documentation'; break;
      case 'test': category = 'Tests'; break;
      case 'build': category = 'Build'; break;
      case 'ci': category = 'CI'; break;
      case 'revert': category = 'Reverts'; break;
      case 'chore': category = 'Chore'; break;
      default:
        category = inferCategoryFromSubject(p.subject);
        break;
    }
    push(category, item);
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
  if (config.engine === 'none') {
    throw new Error('No engine available');
  }
  try {
    const systemPrompt = 'You write crisp, well-structured changelog entries in Markdown.';
    return await callLlmApi(config, { systemPrompt, userPrompt: prompt });
  } catch (err) {
    // Re-throw to be caught by the heuristic fallback logic
    throw new Error(`LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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