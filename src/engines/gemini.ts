import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';
import { buildContext, buildPrompt, parseCandidates } from './shared.js';
import { callLlmApi } from './llm-client.js';

export async function generateWithGemini(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  const context = buildContext(changes);
  const userPrompt = buildPrompt(changes, context);

  // Gemini works well with the full prompt in the user message
  const text = await callLlmApi(config, { userPrompt });

  const lines = parseCandidates(text);
  if (lines.length > 0) return lines;

  throw new Error('Gemini response format unexpected: No valid commit messages found.');
}
