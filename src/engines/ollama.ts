import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';
import { buildContext, buildPrompt, parseCandidates } from './shared.js';

export async function generateWithOllama(
    changes: StagedChanges,
    config: Config
): Promise<string[]> {
    const OLLAMA_API = 'http://127.0.0.1:11434/api/generate';

    // Build compact context and standard prompt
    const context = buildContext(changes);
    const prompt = buildPrompt(changes, context);

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
        const lines = parseCandidates(text);
        if (lines.length >= 3) return lines;

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

// Context and parsing helpers now shared in ./shared.ts
