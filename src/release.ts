import { readFileSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import { execa } from 'execa';
import type { Config } from './config.js';
import { upsertChangelog } from './changelog.js';

type Bump = 'major' | 'minor' | 'patch' | 'none';

interface CommitEntry {
  subject: string;
  body: string;
}

export interface ReleaseResult {
  baseRef: string | null;
  bump: Bump;
  nextVersion: string; // e.g., v1.2.3
  changelogPath?: string;
  tagCreated?: boolean;
  packageUpdated?: boolean;
  preview?: string;
}

export async function runRelease(opts: { 
  config: Config; 
  updatePkg?: boolean; 
  dryRun?: boolean; 
  bumpOverride?: Bump; 
  releaseAs?: string; 
  sinceRef?: string | null; 
}): Promise<ReleaseResult> {
  const baseRef = typeof opts.sinceRef !== 'undefined' ? (opts.sinceRef || null) : await getLastSemverTag();
  const commits = await getCommitsSince(baseRef);
  const detected = detectBump(commits);
  const bump = opts.bumpOverride ?? detected;

  const baseVersion = await getBaseVersion(baseRef);
  const computed = toTagged(computeNext(baseVersion, bump));
  const nextVersion = opts.releaseAs ? toTagged(normalizeVersion(opts.releaseAs)) : computed;

  // Generate/insert changelog for this version
  const cl = await upsertChangelog({
    config: opts.config,
    versionLabel: nextVersion,
    path: opts.config.changelogPath,
    sinceRef: baseRef || undefined,
    dryRun: !!opts.dryRun,
  });

  let pkgUpdated = false;
  if (opts.updatePkg) {
    if (!opts.dryRun) {
      await updatePackageJson(stripV(nextVersion));
    }
    pkgUpdated = true;
  }

  let tagCreated = false;
  if (!opts.dryRun) {
    await createTag(nextVersion);
    tagCreated = true;
  }

  return {
    baseRef,
    bump,
    nextVersion,
    changelogPath: cl.path,
    tagCreated,
    packageUpdated: pkgUpdated,
    preview: cl.preview,
  };
}

async function getLastSemverTag(): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['tag', '--list', 'v*.*.*']);
    const tags = stdout.split('\n').map(s => s.trim()).filter(Boolean).filter(isSemverTag);
    if (tags.length === 0) return null;
    tags.sort(compareSemverTags);
    return tags[tags.length - 1];
  } catch {
    return null;
  }
}

function isSemverTag(tag: string): boolean {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

function compareSemverTags(a: string, b: string): number {
  const pa = parseSemver(stripV(a));
  const pb = parseSemver(stripV(b));
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function parseSemver(v: string): { major: number; minor: number; patch: number } {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return { major: 0, minor: 0, patch: 0 };
  return { major: parseInt(m[1]), minor: parseInt(m[2]), patch: parseInt(m[3]) };
}

function stripV(v: string): string {
  return v.startsWith('v') ? v.slice(1) : v;
}

function toTagged(v: string): string { return v.startsWith('v') ? v : `v${v}`; }

async function getBaseVersion(lastTag: string | null): Promise<string> {
  if (lastTag && isSemverTag(lastTag)) return stripV(lastTag);
  // Fallback to package.json version
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    if (pkg?.version && /\d+\.\d+\.\d+/.test(pkg.version)) return pkg.version;
  } catch {}
  return '0.0.0';
}

async function getCommitsSince(ref: string | null): Promise<CommitEntry[]> {
  const range = ref ? `${ref}..HEAD` : 'HEAD';
  const args = ['log', '--no-merges', `--pretty=%s%x1f%b%x1e`, range];
  const { stdout } = await execa('git', args);
  return stdout
    .split('\x1e')
    .map(s => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [s, b] = rec.split('\x1f');
      return { subject: s, body: (b || '').trim() } as CommitEntry;
    });
}

function detectBump(commits: CommitEntry[]): Bump {
  let major = false;
  let minor = false;
  let patch = false;
  for (const c of commits) {
    const m = c.subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:/);
    const type = m ? m[1].toLowerCase() : '';
    const bang = Boolean(m && m[3]);
    const hasBreaking = bang || /(^|\n)BREAKING CHANGES?:/i.test(c.body);
    if (hasBreaking) major = true;
    else if (type === 'feat') minor = true;
    else if (['fix', 'perf', 'refactor', 'revert'].includes(type)) patch = true;
  }
  if (major) return 'major';
  if (minor) return 'minor';
  if (patch) return 'patch';
  // If there are commits but none matched, default to patch
  return commits.length > 0 ? 'patch' : 'none';
}

function computeNext(base: string, bump: Bump): string {
  const v = parseSemver(base);
  switch (bump) {
    case 'major': return `${v.major + 1}.0.0`;
    case 'minor': return `${v.major}.${v.minor + 1}.0`;
    case 'patch': return `${v.major}.${v.minor}.${v.patch + 1}`;
    case 'none': return base; // no changes
  }
}

function normalizeVersion(v: string): string {
  // Accepts 1.2.3 or v1.2.3 and returns 1.2.3
  return stripV(v.trim());
}

async function updatePackageJson(newVersion: string): Promise<void> {
  const path = 'package.json';
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, 'utf-8'));
  pkg.version = newVersion;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

async function createTag(tag: string): Promise<void> {
  // If tag exists, do nothing
  try {
    const { stdout } = await execa('git', ['tag', '--list', tag]);
    if (stdout.trim() === tag) return;
  } catch {}
  await execa('git', ['tag', '-a', tag, '-m', tag]);
}
