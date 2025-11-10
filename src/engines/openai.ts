import type { StagedChanges } from '../git.js';
import type { Config } from '../config.js';

export async function generateWithOpenAI(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not found. Set it or use --engine ollama|none');
  }

  // Similar implementation to Ollama but using OpenAI API
  // For MVP, throw error prompting user to implement or use other engine
  throw new Error('OpenAI engine not yet implemented in MVP. Use --engine ollama or --engine none');
}