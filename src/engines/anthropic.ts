import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';

export async function generateWithAnthropic(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not found. Set it or use --engine ollama|none');
  }

  // Similar implementation to Ollama but using Anthropic API
  // For MVP, throw error prompting user to implement or use other engine
  throw new Error('Anthropic engine not yet implemented in MVP. Use --engine ollama or --engine none');
}