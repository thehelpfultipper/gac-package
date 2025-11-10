#!/usr/bin/env node
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { getStagedChanges, commitWithMessage } from './git.js';
import { generateCandidates } from './generator.js';
import { loadConfig } from './config.js';

const program = new Command();

program
  .name('gac')
  .description('Smart, succinct Git commit messages')
  .version('1.0.0')
  .option('--prefix <text>', 'Prefix for commit message (e.g., "JIRA-123: ")')
  .option('--style <type>', 'Message style: plain|conv|gitmoji|mix', 'mix')
  .option('--engine <name>', 'Engine: ollama|openai|anthropic|none', 'ollama')
  .option('--model <name>', 'Model name for Ollama', 'mistral:7b')
  .option('--max-len <number>', 'Max subject length', '72')
  .option('--dry-run', 'Show message without committing')
  .action(async (options) => {
    console.clear();
    p.intro(pc.bgCyan(pc.black(' gac ')));

    try {
      // Load config (merges with CLI options)
      const config = await loadConfig(options);

      // Get staged changes
      const s = p.spinner();
      s.start('Analyzing staged changes');
      
      const changes = await getStagedChanges();
      
      if (!changes.hasStagedFiles) {
        s.stop('No staged changes found');
        p.note(
          'Stage your changes first:\\n\\n  ' + pc.cyan('git add <files>'),
          'Nothing to commit'
        );
        p.outro(pc.yellow('Exiting...'));
        process.exit(0);
      }

      s.stop(`Found changes in ${changes.fileCount} file(s)`);

      // Generate candidates
      let candidates: string[] = [];
      let currentEngine = config.engine;

      const generateNew = async () => {
        const gen = p.spinner();
        gen.start(`Generating with ${currentEngine}`);
        
        try {
          candidates = await generateCandidates(changes, config);
          gen.stop('Generated 3 options');
        } catch (err) {
          if (currentEngine === 'ollama') {
            gen.stop('Ollama unavailable, using heuristic fallback');
            currentEngine = 'none';
            config.engine = 'none';
            candidates = await generateCandidates(changes, config);
          } else {
            throw err;
          }
        }
      };

      await generateNew();

      // Interactive selection loop
      let prefix = config.prefix || '';
      let running = true;

      while (running) {
        const previewMessages = candidates.map((msg, i) => {
          const full = prefix + msg;
          const len = full.length;
          const indicator = len <= 72 ? pc.green('✓') : pc.yellow('⚠');
          return `${indicator} ${i + 1}. ${pc.bold(full)} ${pc.dim(`(${len} chars)`)}`;
        });

        const action = await p.select({
          message: 'Choose a commit message:',
          options: [
            { value: '1', label: previewMessages[0] },
            { value: '2', label: previewMessages[1] },
            { value: '3', label: previewMessages[2] },
            { value: 'r', label: pc.cyan('↻ Regenerate new options') },
            { value: 'p', label: pc.magenta('✎ Set/change prefix') },
            { value: 'q', label: pc.red('✕ Quit without committing') },
          ],
        });

        if (p.isCancel(action) || action === 'q') {
          p.outro(pc.yellow('Cancelled'));
          process.exit(0);
        }

        if (action === 'r') {
          await generateNew();
          continue;
        }

        if (action === 'p') {
          const newPrefix = await p.text({
            message: 'Enter prefix (leave empty to clear):',
            placeholder: 'JIRA-123: ',
            initialValue: prefix,
          });

          if (p.isCancel(newPrefix)) continue;
          prefix = newPrefix.toString().trim();
          if (prefix && !prefix.endsWith(' ') && !prefix.endsWith(':')) {
            prefix += ': ';
          }
          continue;
        }

        // Commit selected message
        // Ensure action is a string before parsing
        const idx = parseInt(String(action)) - 1;
        const message = prefix + candidates[idx];

        if (config.dryRun) {
          p.note(message, 'Would commit with:');
          p.outro(pc.green('Dry run complete'));
          process.exit(0);
        }

        const confirm = await p.confirm({
          message: `Commit with this message? ${pc.bold(message)}`,
        });

        if (p.isCancel(confirm) || !confirm) {
          continue;
        }

        const commit = p.spinner();
        commit.start('Committing');
        await commitWithMessage(message);
        commit.stop('Committed successfully');

        p.outro(pc.green('✓ Done!'));
        running = false;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      p.log.error(pc.red(`Error: ${msg}`));
      p.outro(pc.red('Failed'));
      process.exit(1);
    }
  });

program.parse();
