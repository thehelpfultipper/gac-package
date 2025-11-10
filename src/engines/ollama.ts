import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';

export async function generateWithOllama(
    changes: StagedChanges,
    config: Config
): Promise<string[]> {
    const OLLAMA_API = 'http://localhost:11434/api/generate';

    // Build compact context
    const context = buildContext(changes);

    const prompt = `Repo: ${changes.repoName}
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

    const response = await fetch(OLLAMA_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: config.model,
            prompt,
            stream: false,
            options: {
                temperature: 0.7,
                top_p: 0.9,
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.statusText}`);
    }

    const data = (await response.json()) as unknown;
    const text = (typeof data === 'object' && data !== null && 'response' in data &&
        typeof (data as any).response === 'string')
        ? (data as any).response
        : '';

    // Parse out the 3 lines
    const lines = text
        .split('\n')
        .map((l:string) => l.replace(/^\d+\.\s*/, '').trim())
        .filter((l:string) => l.length > 0);

    if (lines.length >= 3) {
        return lines.slice(0, 3);
    }

    // Fallback if parsing failed
    throw new Error('Ollama response format unexpected');
}

function buildContext(changes: StagedChanges): string {
    const parts: string[] = [];

    for (const file of changes.files.slice(0, 10)) {
        const status = {
            A: 'Added',
            M: 'Modified',
            D: 'Deleted',
            R: 'Renamed',
            C: 'Copied',
        }[file.status] || 'Changed';

        parts.push(`${status}: ${file.path} (+${file.additions}/-${file.deletions})`);

        if (file.summary) {
            parts.push(`  → ${file.summary}`);
        }
    }

    if (changes.files.length > 10) {
        parts.push(`... and ${changes.files.length - 10} more files`);
    }

    return parts.join('\n');
}
