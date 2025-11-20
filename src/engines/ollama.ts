import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';
import { buildContext, buildPrompt, parseCandidates } from './shared.js';
import { callLlmApi } from './llm-client.js';

export async function generateWithOllama(
    changes: StagedChanges,
    config: Config
): Promise<string[]> {
    const context = buildContext(changes);
    const prompt = buildPrompt(changes, context);

    // Ollama's generate endpoint takes a single combined prompt
    const text = await callLlmApi(config, { userPrompt: prompt });

    const lines = parseCandidates(text);
    // We accept even a single valid candidate rather than failing hard
    if (lines.length > 0) return lines;

    throw new Error('Ollama response format unexpected: No valid commit messages found.');
}
