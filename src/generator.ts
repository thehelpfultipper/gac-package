import type { StagedChanges } from './git.js';
import type { Config } from './config.js';
import { generateWithOllama } from './engines/ollama.js';
import { generateWithOpenAI } from './engines/openai.js';
import { generateWithAnthropic } from './engines/anthropic.js';
import { generateWithGemini } from './engines/gemini.js';
import { generateHeuristic } from './engines/heuristic.js';

export async function generateCandidates(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  let candidates: string[] = [];

  switch (config.engine) {
    case 'ollama':
      candidates = await generateWithOllama(changes, config);
      break;
    case 'openai':
      candidates = await generateWithOpenAI(changes, config);
      break;
    case 'anthropic':
      candidates = await generateWithAnthropic(changes, config);
      break;
    case 'gemini':
      candidates = await generateWithGemini(changes, config);
      break;
    case 'none':
    default:
      candidates = await generateHeuristic(changes, config);
      break;
  }

  // Ensure all candidates have consistent formatting
  return candidates.map(c => sanitizeCandidate(c));
}

function sanitizeCandidate(message: string): string {
  // Keep the full subject so we never cut mid-thought; the CLI surfaces length warnings.
  return message.trim().replace(/\.+$/, '');
}
