import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';
import { buildContext, buildPrompt, parseCandidates } from './shared.js';

export async function generateWithOpenAI(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not found. Set it or use --engine ollama|none');
  }

  const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

  // Build compact context and standard prompt
  const context = buildContext(changes);
  const userPrompt = buildPrompt(changes, context);

  // Prefer a sensible default if an Ollama-style model was provided
  const modelName = config.model && !config.model.includes(':') ? config.model : 'gpt-4o-mini';

  const body = {
    model: modelName,
    temperature: 0.7,
    top_p: 0.9,
    n: 1,
    messages: [
      {
        role: 'system',
        content: 'You write succinct Git commit message subjects. Output exactly three lines as requested. Do not include explanations or extra lines.',
      },
      { role: 'user', content: userPrompt },
    ],
  } as const;

  try {
    const response = await fetch(OPENAI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let details = '';
      try {
        const err: any = await response.json();
        if (err && err.error && err.error.message) details = ` - ${err.error.message}`;
      } catch {
        try { details = ` - ${await response.text()}`; } catch { /* ignore */ }
      }
      if (response.status === 401) {
        throw new Error('OpenAI HTTP 401: Unauthorized - check OPENAI_API_KEY');
      }
      throw new Error(`OpenAI HTTP ${response.status}${details}`);
    }

    const data = (await response.json()) as any;
    const text: string = data?.choices?.[0]?.message?.content ?? '';
    const lines = parseCandidates(text);
    if (lines.length >= 3) return lines;

    throw new Error('OpenAI response format unexpected');
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error('Network error calling OpenAI. Check internet connectivity.');
    }
    throw error;
  }
}
