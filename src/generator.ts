import type { StagedChanges } from './git.js';
import type { Config } from './config.js';
import { generateWithOllama } from './engines/ollama.js';
import { generateWithOpenAI } from './engines/openai.js';
import { generateWithAnthropic } from './engines/anthropic.js';
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
    case 'none':
    default:
      candidates = await generateHeuristic(changes, config);
      break;
  }

  // Ensure all candidates meet length requirements
  return candidates.map(c => enforceMaxLength(c, config.maxLen));
}

function enforceMaxLength(message: string, maxLen: number): string {
  let msg = message.trim().replace(/\.+$/, ''); // Remove trailing periods
  
  if (msg.length <= maxLen) return msg;

  // Try to trim at word boundary
  const trimmed = msg.slice(0, maxLen);
  const lastSpace = trimmed.lastIndexOf(' ');
  
  return lastSpace > maxLen * 0.7 ? trimmed.slice(0, lastSpace) : trimmed;
}