import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { execa } from "execa";

export interface Config {
  prefix: string;
  style: "plain" | "conv" | "gitmoji" | "mix";
  engine: "ollama" | "openai" | "anthropic" | "gemini" | "none";
  model: string;
  maxLen: number;
  dryRun: boolean;
  ignoredFiles: string[];
  // Optional per-run variation seed for deterministic regeneration
  regen?: number;
  // Optional API keys for paid engines
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  // Changelog options (configurable via CLI, .gacrc, or package.json#gac)
  changelogPath?: string;
  changelogSince?: string;
}

export async function loadConfig(cliOptions: any): Promise<Config> {
  const defaults: Config = {
    prefix: "",
    style: "mix",
    engine: "ollama",
    model: "mistral:7b",
    maxLen: 72,
    dryRun: false,
    ignoredFiles: [],
  };

  // Try to load .gacrc
  let fileConfig: Partial<Config> = {};
  const configPath = join(process.cwd(), ".gacrc");

  if (existsSync(configPath)) {
    try {
      const content = await readFile(configPath, "utf-8");
      fileConfig = JSON.parse(content);
    } catch {
      // Invalid config, ignore
    }
  }

  // Try package.json "gac" field
  const pkgPath = join(process.cwd(), "package.json");
  if (existsSync(pkgPath)) {
    try {
      const content = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.gac) {
        fileConfig = { ...fileConfig, ...pkg.gac };
      }
    } catch {
      // Invalid package.json, ignore
    }
  }

  // Load .gacignore
  const ignorePath = join(process.cwd(), ".gacignore");
  let ignoredPatterns: string[] = [];
  if (existsSync(ignorePath)) {
    try {
      const content = await readFile(ignorePath, "utf-8");
      ignoredPatterns = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
    } catch {
      // Invalid ignore file, ignore
    }
  }

  // Auto-detect prefix from branch name if not provided
  let autoPrefix = "";
  if (!cliOptions.prefix && !fileConfig.prefix) {
    try {
      const { stdout: branch } = await execa("git", [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      const match = branch.match(/([A-Z]{2,}-\\d{1,7})/);
      if (match) {
        autoPrefix = match[1] + ": ";
      }
    } catch {
      // Ignore - not in a git repo or other error
    }
  }

  // Merge: defaults < file config < env vars < CLI options
  const envPrefix = process.env.GAC_PREFIX;
  const envOpenAI = process.env.OPENAI_API_KEY;
  const envAnthropic = process.env.ANTHROPIC_API_KEY;
  const envGemini = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  const mergedIgnored = [
    ...(fileConfig.ignoredFiles || []),
    ...ignoredPatterns,
  ];

  return {
    prefix:
      cliOptions.prefix ||
      envPrefix ||
      fileConfig.prefix ||
      autoPrefix ||
      defaults.prefix,
    style: cliOptions.style || fileConfig.style || defaults.style,
    engine: cliOptions.engine || fileConfig.engine || defaults.engine,
    model: cliOptions.model || fileConfig.model || defaults.model,
    maxLen: parseInt(cliOptions.maxLen) || fileConfig.maxLen || defaults.maxLen,
    dryRun: cliOptions.dryRun || fileConfig.dryRun || defaults.dryRun,
    ignoredFiles: mergedIgnored,
    openaiApiKey:
      cliOptions.openaiApiKey || envOpenAI || (fileConfig as any).openaiApiKey,
    anthropicApiKey:
      cliOptions.anthropicApiKey ||
      envAnthropic ||
      (fileConfig as any).anthropicApiKey,
    geminiApiKey:
      cliOptions.geminiApiKey || envGemini || (fileConfig as any).geminiApiKey,
    changelogPath:
      cliOptions.changelogPath || (fileConfig as any).changelogPath,
    changelogSince: cliOptions.since || (fileConfig as any).changelogSince,
  };
}
