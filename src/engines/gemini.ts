import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';
import { buildContext, buildPrompt, parseCandidates } from './shared.js';

export async function generateWithGemini(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY not found. Set it or use --engine ollama|none');
  }

  // Build context and prompt
  const context = buildContext(changes);
  const userPrompt = buildPrompt(changes, context);

  // Model mapping: use provided model if it doesn't look like an Ollama tag
  const modelName = config.model && !config.model.includes(':') ? config.model : 'gemini-1.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      topP: 0.9,
    },
  } as const;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let details = '';
      try {
        const err: any = await response.json();
        if (err?.error?.message) details = ` - ${err.error.message}`;
      } catch {
        try { details = ` - ${await response.text()}`; } catch {}
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Gemini HTTP ${response.status}: Unauthorized/Forbidden - check GEMINI_API_KEY or GOOGLE_API_KEY`);
      }
      throw new Error(`Gemini HTTP ${response.status}${details}`);
    }

    const data = (await response.json()) as any;
    // Try to extract text from candidates
    let text = '';
    const first = data?.candidates?.[0];
    if (first?.content?.parts && Array.isArray(first.content.parts)) {
      text = first.content.parts.map((p: any) => p?.text || '').filter(Boolean).join('\n');
    } else if (first?.output_text) {
      text = first.output_text;
    }

    const lines = parseCandidates(text);
    if (lines.length >= 3) return lines;

    throw new Error('Gemini response format unexpected');
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error('Network error calling Gemini. Check internet connectivity.');
    }
    throw error;
  }
}

