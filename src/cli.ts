#!/usr/bin/env node
/// <reference types="node" />
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import updateNotifier from "update-notifier";
import { getStagedChanges, commitWithMessage } from "./git.js";
import { generateCandidates } from "./generator.js";
import { loadConfig } from "./config.js";

// Read and parse package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

// Check for updates and notify the user if a new version is available.
updateNotifier({ pkg }).notify();

// A wrapper around `p.select` that adds single-character keyboard shortcuts.
interface SelectOption {
  value: string | symbol;
  label: string;
  hint?: string;
}

export async function selectWithShortcuts(
  options: SelectOption[],
  candidateOptions: SelectOption[]
): Promise<string | symbol> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    let index = 0;
    const total = options.length;
    let linesWritten = 0;

    function render(): void {
      if (linesWritten > 0) {
        stdout.write(`\x1b[${linesWritten}A\x1b[J`);
      }

      let output = "";
      const addLine = (str: string) => (output += str + "\n");

      addLine(`${pc.cyan("◇")} ${pc.bold("Choose a commit message:")}`);
      addLine("");

      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const isSelected = i === index;

        const prefix = isSelected ? `${pc.cyan("❯")} ` : "  ";
        const label = isSelected ? pc.cyan(opt.label) : pc.dim(opt.label);
        const hint = opt.hint ? ` ${pc.dim(opt.hint)}` : "";

        addLine(`${prefix}${label}${hint}`);
      }

      addLine("");
      addLine(pc.dim("  Use ↑/↓, Enter, or shortcuts (1-3, r, p, q)"));

      stdout.write(output);
      linesWritten = output.split("\n").length - 1;
    }

    function cleanup(): void {
      stdin.setRawMode(false);
      stdin.removeListener("data", onKey);
      stdin.pause();
    }

    function choose(value: string | symbol): void {
      if (linesWritten > 0) {
        stdout.write(`\x1b[${linesWritten}A\x1b[J`);
      }
      cleanup();
      resolve(value);
    }

    function onKey(buffer: Buffer): void {
      const key = buffer.toString();

      // Arrow keys
      if (buffer[0] === 0x1b && buffer[1] === 0x5b) {
        if (buffer[2] === 0x41) {
          // up
          index = (index - 1 + total) % total;
          render();
          return;
        }
        if (buffer[2] === 0x42) {
          // down
          index = (index + 1) % total;
          render();
          return;
        }
      }

      // Enter
      if (buffer[0] === 0x0d) {
        choose(options[index].value);
        return;
      }

      // Ctrl+C
      if (buffer[0] === 3) {
        choose("quit");
        return;
      }

      // r / p / q
      if (key === "r") return choose("regenerate");
      if (key === "p") return choose("prefix");
      if (key === "q") return choose("quit");

      // Numeric shortcuts 1–3
      const num = parseInt(key, 10);
      if (!isNaN(num) && num >= 1 && num <= candidateOptions.length) {
        choose(candidateOptions[num - 1].value);
        return;
      }
    }

    // Enable raw input mode
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);

    render();
  });
}

const program = new Command();

program
  .usage("[options]")
  .description("Smart, succinct Git commit messages")
  .version(pkg.version)
  .option("--prefix <text>", 'Prefix for commit message (e.g., "JIRA-123: ")')
  // Do not set defaults here; loadConfig provides defaults and merges with .gacrc/env
  .option("--style <type>", "Message style: plain|conv|gitmoji|mix")
  .option("--engine <name>", "Engine: ollama|openai|anthropic|gemini|none")
  .option(
    "--model <name>",
    "Model name for LLM engine (Ollama, OpenAI, Gemini)"
  )
  .option("--max-len <number>", "Max subject length")
  .option(
    "--changelog [version]",
    "Generate/update CHANGELOG.md (optional version label)"
  )
  .option("--changelog-path <path>", "Override changelog file path")
  .option(
    "--since <ref>",
    "Generate changelog entries since Git ref (tag/commit)"
  )
  .option(
    "--release",
    "Auto-bump version, update CHANGELOG, and create Git tag"
  )
  .option(
    "--bump <level>",
    "Release bump: patch|minor|major (overrides auto-detect)"
  )
  .option(
    "--release-as <version>",
    "Release as exact version (e.g., 1.2.3 or v1.2.3)"
  )
  .option("--update-pkg", "Also update package.json version when releasing")
  .option("--dry-run", "Show message without committing")
  .addHelpText(
    "after",
    `
    Examples:
      $ gac                          # Generate commit message using default settings
      $ gac --style conv             # Generate a Conventional Commits style message
      $ gac --engine none            # Use the non-AI heuristic engine for instant results
      $ gac --prefix "TICKET-42: "   # Add a prefix to the commit message
      $ gac --release --bump minor   # Create a new minor release (e.g., v1.1.0 -> v1.2.0)
      $ gac --changelog --dry-run    # Preview changelog without writing files or tagging
  `
  )
  .action(async (options) => {
    console.clear();
    p.intro(pc.bgCyan(pc.black(" gac ")));

    try {
      // Load config (merges with CLI options)
      const config = await loadConfig(options);

      // Release mode: bump version, update changelog, create tag, then exit
      if (options.release) {
        const { runRelease } = await import("./release.js");
        const s = p.spinner();
        s.start("Analyzing commits for release");
        try {
          const bumpLevel =
            typeof options.bump === "string"
              ? String(options.bump).toLowerCase()
              : undefined;
          const bumpOverride =
            bumpLevel === "major" ||
            bumpLevel === "minor" ||
            bumpLevel === "patch"
              ? bumpLevel
              : undefined;
          const result = await runRelease({
            config,
            updatePkg: !!options.updatePkg,
            dryRun: !!config.dryRun,
            bumpOverride,
            releaseAs: options["releaseAs"],
            sinceRef: options.since || null,
          });
          s.stop("Release plan ready");

          const summary: string[] = [];
          summary.push(`Base: ${result.baseRef ?? "none"}`);
          summary.push(`Bump: ${result.bump}`);
          summary.push(`Next: ${pc.bold(result.nextVersion)}`);
          p.note(summary.join("\n"), "Release");

          if (result.preview) p.note(result.preview, "Changelog preview");

          if (!config.dryRun) {
            p.note(`Tag created: ${result.tagCreated ? "yes" : "no"}`, "Tag");
            if (options.updatePkg)
              p.note("package.json version updated", "Package");
          }

          p.outro(
            pc.green(config.dryRun ? "Dry run complete" : "Release complete")
          );
          process.exit(0);
        } catch (err: any) {
          s.stop("Failed to create release");
          p.outro(pc.red(err?.message || String(err)));
          process.exit(1);
        }
      }

      // Changelog mode: generate or update CHANGELOG and exit
      if (options.changelog !== undefined) {
        const { upsertChangelog } = await import("./changelog.js");
        const s = p.spinner();
        s.start("Generating changelog");
        try {
          const emptySinceToNull = (val: any) =>
            typeof val === "string" && val.trim() === "" ? null : val;
          const result = await upsertChangelog({
            config,
            versionLabel:
              typeof options.changelog === "string"
                ? options.changelog
                : undefined,
            dryRun: !!config.dryRun,
            path: options.changelogPath || config.changelogPath,
            // Allow forcing full history via --since ""
            sinceRef:
              emptySinceToNull(options.since) ??
              emptySinceToNull(config.changelogSince) ??
              undefined,
          });
          s.stop(
            result.written ? `Updated ${result.path}` : "Changelog preview"
          );
          if (result.preview) {
            p.note(result.preview, "Preview");
          } else {
            p.note(`Path: ${result.path}`, "Changelog");
          }
          p.outro(pc.green("Done"));
          process.exit(0);
        } catch (err: any) {
          s.stop("Failed to generate changelog");
          p.outro(pc.red(err?.message || String(err)));
          process.exit(1);
        }
      }

      // Get staged changes
      const s = p.spinner();
      s.start("Analyzing staged changes");

      const changes = await getStagedChanges();

      if (!changes.hasStagedFiles) {
        s.stop("No staged changes found");
        p.note(
          "Stage your changes first:\\n\\n  " + pc.cyan("git add <files>"),
          "Nothing to commit"
        );
        p.outro(pc.yellow("Exiting..."));
        process.exit(0);
      }

      s.stop(`Found changes in ${changes.fileCount} file(s)`);

      // Generate candidates
      let candidates: string[] = [];
      let currentEngine = config.engine;
      let regen = 0;

      const generateNew = async () => {
        const gen = p.spinner();
        gen.start(`Generating with ${currentEngine}`);

        try {
          // Pass deterministic regen counter for variation
          config.regen = regen;
          candidates = await generateCandidates(changes, config);
          gen.stop("Generated 3 options");
        } catch (err) {
          if (currentEngine === "ollama") {
            gen.stop("Ollama unavailable, using heuristic fallback");
            currentEngine = "none";
            config.engine = "none";
            config.regen = regen;
            candidates = await generateCandidates(changes, config);
          } else {
            throw err;
          }
        }
      };

      await generateNew();

      // Interactive selection loop
      let prefix = config.prefix || "";
      let running = true;

      while (running) {
        const maxLen =
          typeof config.maxLen === "number" && config.maxLen > 0
            ? config.maxLen
            : 72;

        const candidateOptions = candidates.map((msg, i) => {
          const full = prefix + msg;
          const len = full.length;
          const indicator = len <= maxLen ? pc.green("✓") : pc.yellow("⚠");
          const label = `${indicator} ${i + 1}. ${pc.bold(full)}`;
          const hint = `(${len}/${maxLen} chars)`;
          return { value: full, label, hint };
        });

        const action = await selectWithShortcuts(
          [
            ...candidateOptions,
            {
              value: "regenerate",
              label: pc.cyan("↻ Regenerate new options"),
              hint: "(r)",
            },
            {
              value: "prefix",
              label: pc.magenta("✎ Set/change prefix"),
              hint: "(p)",
            },
            {
              value: "quit",
              label: pc.red("✕ Quit without committing"),
              hint: "(q)",
            },
          ],
          candidateOptions
        );

        if (action === "quit") {
          p.outro(pc.yellow("Cancelled"));
          process.exit(0);
        }

        if (action === "regenerate") {
          regen += 1;
          await generateNew();
          continue;
        }

        if (action === "prefix") {
          const newPrefix = await p.text({
            message: "Enter prefix (leave empty to clear):",
            placeholder: "JIRA-123: ",
            initialValue: prefix,
          });

          if (p.isCancel(newPrefix)) continue;
          prefix = newPrefix.toString().trim();
          if (prefix && !prefix.endsWith(" ") && !prefix.endsWith(":")) {
            prefix += ": ";
          }
          continue;
        }

        // A commit message was selected, now allow editing.
        // The value from p.select is the message string itself.
        const selectedMessage = String(action);

        const finalMessage = await p.text({
          message: `Edit commit message ${pc.dim(
            "(Enter to commit, Ctrl+C to go back)"
          )}`,
          initialValue: selectedMessage,
          validate(value) {
            if (value.trim().length === 0)
              return "Commit message cannot be empty.";
          },
        });

        if (p.isCancel(finalMessage)) {
          // User pressed Esc, go back to selection.
          continue;
        }

        const trimmedMessage = String(finalMessage).trim();

        if (config.dryRun) {
          p.note(trimmedMessage, "Would commit with:");
          p.outro(pc.green("Dry run complete"));
          process.exit(0);
        }

        const commit = p.spinner();
        commit.start("Committing");
        await commitWithMessage(trimmedMessage);
        commit.stop("Committed successfully");

        p.outro(pc.green("✓ Done!"));
        running = false;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      p.log.error(pc.red(`Error: ${msg}`));
      p.outro(pc.red("Failed"));
      process.exit(1);
    }
  });

program.parse();
