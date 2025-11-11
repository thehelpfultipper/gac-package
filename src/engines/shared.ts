import type { StagedChanges } from '../git.js';
import { capitalizeFirst } from './heuristic.js';

export function buildContext(changes: StagedChanges): string {
  const parts: string[] = [];

  for (const file of changes.files.slice(0, 10)) {
    const status = (
      {
        A: 'Added',
        M: 'Modified',
        D: 'Deleted',
        R: 'Renamed',
        C: 'Copied',
      } as Record<string, string>
    )[file.status] || 'Changed';

    const changeSize = file.additions + file.deletions;
    const sizeIndicator = changeSize > 100 ? ' (large)' : changeSize > 20 ? ' (medium)' : '';

    parts.push(`${status}: ${file.path} (+${file.additions}/-${file.deletions})${sizeIndicator}`);

    if (file.summary && (file.status === 'M' || file.status === 'A')) {
      parts.push(`  Key changes: ${file.summary}`);
    }
  }

  if (changes.files.length > 10) {
    parts.push(`... and ${changes.files.length - 10} more files`);
  }

  return parts.join('\n');
}

export function buildPrompt(changes: StagedChanges, context: string): string {
  return `Repo: ${changes.repoName}
    Branch: ${changes.branch}

    Staged changes:
    ${context}

    Generate exactly 3 different commit message subjects (one per line):
    1. Conventional Commits format (type(scope): subject)
    2. Plain imperative format (no type prefix)
    3. Gitmoji format (emoji + subject)

    Rules:
    - Max 72 characters per line
    - Imperative mood (add, fix, update - not added, fixed, updated)
    - No trailing period
    - No quotes
    - Be specific and concise`;
}

export function parseCandidates(text: string): string[] {
  const lines = String(text)
    .split('\n')
    .map((l: string) => l.replace(/^\s*[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim())
    .filter((l: string) => l.length > 0)
    .map((l: string) => capitalizeFirst(l));
  return lines.slice(0, 3);
}

