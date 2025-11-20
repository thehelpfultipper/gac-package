import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';
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

export function buildPrompt(changes: StagedChanges, context: string, config: Config): string {
  const maxLen = config.maxLen || 72;
  let styleInstruction = '';

  switch (config.style) {
    case 'plain':
      styleInstruction = 'Generate 3 distinct commit message subjects in plain imperative format (no type prefix, no emojis).';
      break;
    case 'gitmoji':
      styleInstruction = 'Generate 3 distinct commit message subjects in Gitmoji format (start with an emoji representing the change type).';
      break;
    case 'conv':
      styleInstruction = 'Generate 3 distinct commit message subjects in Conventional Commits format (type(scope): subject).';
      break;
    case 'mix':
    default:
      styleInstruction = `Generate exactly 3 different commit message subjects (one per line):
        1. Conventional Commits format (type(scope): subject)
        2. Plain imperative format (no type prefix)
        3. Gitmoji format (emoji + subject)`;
      break;
  }

  return `Repo: ${changes.repoName}
    Branch: ${changes.branch}

    Staged changes:
    ${context}

    ${styleInstruction}

    Rules:
    - Max ${maxLen} characters per line
    - Imperative mood (add, fix, update - not added, fixed, updated)
    - No trailing period
    - No quotes around the messages
    - No Markdown code blocks or backticks
    - No conversational text (do not say "Here are the options")
    - Be specific and concise`;
}

export function parseCandidates(text: string): string[] {
  // Strip Markdown code blocks
  let cleanText = text.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  });

  // If no blocks were matched/replaced, but text contains isolated fences, strip them
  if (cleanText === text) {
    cleanText = text.replace(/^```[a-z]*$/gim, '');
  }

  const lines = cleanText
    .split('\n')
    .map((l) => {
      let line = l.trim();
      // Remove markdown list markers (1., -, *)
      line = line.replace(/^(\d+\.|[-*])\s+/, '');
      // Remove prefixes like "Option 1:" or "Conventional:"
      line = line.replace(/^(Option\s+\d+|Format\s+\d+|[a-zA-Z]+):[\s]*/i, (match) => {
        // Don't strip "feat:" or "fix:", those are valid commit types.
        if (match.toLowerCase().startsWith('feat') || match.toLowerCase().startsWith('fix')) return match;
        return '';
      });
      // Remove outer quotes
      line = line.replace(/^["']|["']$/g, '');
      // Remove backticks wrapping the line
      line = line.replace(/^`|`$/g, '');
      return line.trim();
    })
    .filter((l) => {
      if (l.length < 3) return false; // Too short
      const lower = l.toLowerCase();
      // Filter conversational filler
      if (lower.startsWith('here are')) return false;
      if (lower.startsWith('sure,')) return false;
      if (lower.startsWith('certainly')) return false;
      if (lower.startsWith('below are')) return false;
      if (lower.startsWith('these are')) return false;
      // Filter lines that are just labels
      if (lower === 'conventional commits format' || lower === 'plain imperative format') return false;
      return true;
    })
    .map((l) => capitalizeFirst(l));

  // Deduplicate and limit to 3
  return [...new Set(lines)].slice(0, 3);
}

