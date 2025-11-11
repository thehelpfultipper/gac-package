import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';
import { capitalizeFirst } from './heuristic.js';

export async function generateWithOllama(
    changes: StagedChanges,
    config: Config
): Promise<string[]> {
    const OLLAMA_API = 'http://127.0.0.1:11434/api/generate';

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

    try {
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
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`Ollama HTTP ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as unknown;
        const text = (typeof data === 'object' && data !== null && 'response' in data &&
            typeof (data as any).response === 'string')
            ? (data as any).response
            : '';

        // Parse out the 3 lines
        const lines = text
            .split('\n')
            .map((l: string) => l.replace(/^\d+\.\s*/, '').trim())
            .filter((l: string) => l.length > 0)
            .map((l: string) => capitalizeFirst(l));

        if (lines.length >= 3) {
            return lines.slice(0, 3);
        }

        // Fallback if parsing failed
        throw new Error('Ollama response format unexpected');
    } catch (error) {
        // Re-throw with more context for connection errors
        if (error instanceof TypeError && error.message.includes('fetch')) {
            throw new Error(`Cannot connect to Ollama at ${OLLAMA_API}. Is ollama serve running?`);
        }
        throw error;
    }
}

function buildContext(changes: StagedChanges): string {
    const parts: string[] = [];

    // Limit to top 10 files to keep context compact
    const filesToShow = changes.files.slice(0, 10);

    for (const file of changes.files.slice(0, 10)) {
        const status = {
            A: 'Added',
            M: 'Modified',
            D: 'Deleted',
            R: 'Renamed',
            C: 'Copied',
        }[file.status] || 'Changed';

        const changeSize = file.additions + file.deletions;
        const sizeIndicator = changeSize > 100 ? ' (large)' : changeSize > 20 ? ' (medium)' : '';

        parts.push(`${status}: ${file.path} (+${file.additions}/-${file.deletions})${sizeIndicator}`);

        // Only include summary for modified/added files with identifiable changes
        if (file.summary && (file.status === 'M' || file.status === 'A')) {
            parts.push(`  Key changes: ${file.summary}`);
        }
    }

    if (changes.files.length > 10) {
        parts.push(`... and ${changes.files.length - 10} more files`);
    }

    return parts.join('\n');
}
