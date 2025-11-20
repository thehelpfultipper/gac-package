import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';
import { buildContext, buildPrompt, parseCandidates } from './shared.js';
import { callLlmApi } from './llm-client.js';

export async function generateWithOpenAI(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  const context = buildContext(changes);
  const userPrompt = buildPrompt(changes, context);
  const systemPrompt = 'You write succinct Git commit message subjects. Output exactly three lines as requested. Do not include explanations, markdown blocks, or quotes.';

  const text = await callLlmApi(config, { systemPrompt, userPrompt });

  const lines = parseCandidates(text);
  if (lines.length > 0) return lines;

  throw new Error('OpenAI response format unexpected: No valid commit messages found.');
}
