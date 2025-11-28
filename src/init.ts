import { writeFileSync, existsSync } from "fs";
import { join } from "path";
import * as p from "@clack/prompts";
import pc from "picocolors";

export async function runInit() {
  console.clear();
  p.intro(pc.bgCyan(pc.black(" gac init ")));

  const configPath = join(process.cwd(), ".gacrc");

  if (existsSync(configPath)) {
    const shouldOverwrite = await p.confirm({
      message: ".gacrc already exists. Overwrite?",
      initialValue: false,
    });

    if (p.isCancel(shouldOverwrite) || !shouldOverwrite) {
      p.outro(pc.yellow("Operation cancelled"));
      return;
    }
  }

  const projectConfig = await p.group(
    {
      engine: () =>
        p.select({
          message: "Select a generation engine:",
          options: [
            {
              value: "ollama",
              label: "Ollama",
              hint: "Free, local, private (Recommended)",
            },
            { value: "openai", label: "OpenAI", hint: "Requires API key" },
            { value: "gemini", label: "Gemini", hint: "Requires API key" },
            { value: "none", label: "Heuristic", hint: "No AI, rule-based" },
          ],
          initialValue: "ollama",
        }),
      model: ({ results }) => {
        if (results.engine === "none") return Promise.resolve(undefined);

        let defaultModel = "mistral:7b";
        if (results.engine === "openai") defaultModel = "gpt-4o-mini";
        if (results.engine === "gemini") defaultModel = "gemini-1.5-flash";

        return p.text({
          message: "Enter model name:",
          initialValue: defaultModel,
          placeholder: defaultModel,
          validate: (value) => {
            if (!value) return "Model name is required";
          },
        });
      },
      style: () =>
        p.select({
          message: "Select commit message style:",
          options: [
            {
              value: "mix",
              label: "Mix",
              hint: "Generates 3 diverse options (Recommended)",
            },
            {
              value: "conv",
              label: "Conventional",
              hint: "feat(scope): subject",
            },
            { value: "gitmoji", label: "Gitmoji", hint: "✨ feat: subject" },
            {
              value: "plain",
              label: "Plain",
              hint: "Simple imperative sentence",
            },
          ],
          initialValue: "mix",
        }),
      maxLen: () =>
        p.text({
          message: "Max subject line length:",
          initialValue: "72",
          validate: (value) => {
            if (isNaN(Number(value))) return "Please enter a number";
          },
        }),
      prefix: () =>
        p.text({
          message: 'Subject prefix (optional, e.g., "JIRA-123: "):',
          placeholder: "",
        }),
    },
    {
      onCancel: () => {
        p.outro(pc.yellow("Operation cancelled"));
        process.exit(0);
      },
    }
  );

  const config: any = {
    engine: projectConfig.engine,
    model: projectConfig.model,
    style: projectConfig.style,
    maxLen: Number(projectConfig.maxLen),
  };

  if (projectConfig.prefix) {
    config.prefix = projectConfig.prefix;
  }

  // Clean up model if none
  if (config.engine === "none") {
    delete config.model;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));

  p.note(JSON.stringify(config, null, 2), "Generated .gacrc");
  p.outro(pc.green("Configuration initialized successfully!"));
}
