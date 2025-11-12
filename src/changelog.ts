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
  const newSection = await generateSectionMarkdown(commits, opts.config, version);

  if (opts.dryRun) {
    return { path, written: false, preview: newSection };
  }

  const content = existed ? mergeIntoExisting(readFileSync(path, 'utf-8'), newSection, version) : buildNewFile(newSection);
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

function mergeIntoExisting(existing: string, newSection: string, version: string): string {
  // If version heading already exists, replace that section; else insert after top H1
  const lines = existing.split('\n');
  const heading = toVersionHeading(version);
  const startIdx = lines.findIndex(l => l.trim().toLowerCase() === heading.trim().toLowerCase());
  if (startIdx !== -1) {
    // Find next version heading or EOF
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { endIdx = i; break; }
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

async function generateSectionMarkdown(commits: CommitEntry[], config: Config, versionLabel: string): Promise<string> {
  const heading = toVersionHeading(versionLabel);
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
    // If model omitted heading, add it
    const hasHeading = /^##\s+/.test(cleaned.split('\n')[0]);
    const body = hasHeading ? cleaned : `${heading}\n\n${cleaned}`;
    return body + '\n';
  } catch {
    return `${heading}\n\n${heuristic.trim()}\n`;
  }
}

function parseConventional(commit: CommitEntry): { type: string; scope?: string; subject: string } {
  const m = commit.subject.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/);
  if (m) return { type: m[1].toLowerCase(), scope: m[2], subject: m[3] };
  return { type: 'other', subject: commit.subject };
}

function categorizeCommits(commits: CommitEntry[]): Map<string, Array<{ scope?: string; subject: string }>> {
  const map = new Map<string, Array<{ scope?: string; subject: string }>>();
  const push = (cat: string, item: { scope?: string; subject: string }) => {
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(item);
  };

  for (const c of commits) {
    const p = parseConventional(c);
    switch (p.type) {
      case 'feat': push('Added', p); break;
      case 'fix': push('Fixed', p); break;
      case 'perf': push('Performance', p); break;
      case 'refactor': push('Changed', p); break;
      case 'docs': push('Docs', p); break;
      case 'test': push('Tests', p); break;
      case 'build':
      case 'ci': push('CI', p); break;
      case 'chore': push('Chore', p); break;
      default: push('Other', p); break;
    }
  }
  return map;
}

function renderMarkdownFromCategories(map: Map<string, Array<{ scope?: string; subject: string }>>): string {
  const sectionsOrder = ['Added', 'Fixed', 'Changed', 'Performance', 'Docs', 'Tests', 'CI', 'Chore', 'Other'];
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
