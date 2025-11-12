#!/usr/bin/env node
/// <reference types="node" />
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
  // Do not set defaults here; loadConfig provides defaults and merges with .gacrc/env
  .option('--style <type>', 'Message style: plain|conv|gitmoji|mix')
  .option('--engine <name>', 'Engine: ollama|openai|anthropic|gemini|none')
  .option('--model <name>', 'Model name for Ollama')
  .option('--max-len <number>', 'Max subject length')
  .option('--changelog [version]', 'Generate/update CHANGELOG.md (optional version label)')
  .option('--changelog-path <path>', 'Override changelog file path')
  .option('--since <ref>', 'Generate changelog entries since Git ref (tag/commit)')
  .option('--release', 'Auto-bump version, update CHANGELOG, and create Git tag')
  .option('--bump <level>', 'Release bump: patch|minor|major (overrides auto-detect)')
  .option('--release-as <version>', 'Release as exact version (e.g., 1.2.3 or v1.2.3)')
  .option('--update-pkg', 'Also update package.json version when releasing')
  .option('--dry-run', 'Show message without committing')
  .action(async (options) => {
    console.clear();
    p.intro(pc.bgCyan(pc.black(' gac ')));

    try {
      // Load config (merges with CLI options)
      const config = await loadConfig(options);

      // Release mode: bump version, update changelog, create tag, then exit
      if (options.release) {
        const { runRelease } = await import('./release.js');
        const s = p.spinner();
        s.start('Analyzing commits for release');
        try {
          const bumpLevel = typeof options.bump === 'string' ? String(options.bump).toLowerCase() : undefined;
          const bumpOverride = (bumpLevel === 'major' || bumpLevel === 'minor' || bumpLevel === 'patch') ? bumpLevel : undefined;
          const result = await runRelease({
            config,
            updatePkg: !!options.updatePkg,
            dryRun: !!config.dryRun,
            bumpOverride,
            releaseAs: options['releaseAs'],
            sinceRef: options.since || null,
          });
          s.stop('Release plan ready');

          const summary: string[] = [];
          summary.push(`Base: ${result.baseRef ?? 'none'}`);
          summary.push(`Bump: ${result.bump}`);
          summary.push(`Next: ${pc.bold(result.nextVersion)}`);
          p.note(summary.join('\n'), 'Release');

          if (result.preview) p.note(result.preview, 'Changelog preview');

          if (!config.dryRun) {
            p.note(`Tag created: ${result.tagCreated ? 'yes' : 'no'}`, 'Tag');
            if (options.updatePkg) p.note('package.json version updated', 'Package');
          }

          p.outro(pc.green(config.dryRun ? 'Dry run complete' : 'Release complete'));
          process.exit(0);
        } catch (err: any) {
          s.stop('Failed to create release');
          p.outro(pc.red(err?.message || String(err)));
          process.exit(1);
        }
      }

      // Changelog mode: generate or update CHANGELOG and exit
      if (options.changelog !== undefined) {
        const { upsertChangelog } = await import('./changelog.js');
        const s = p.spinner();
        s.start('Generating changelog');
        try {
          const emptySinceToNull = (val: any) => (typeof val === 'string' && val.trim() === '') ? null : val;
          const result = await upsertChangelog({
            config,
            versionLabel: typeof options.changelog === 'string' ? options.changelog : undefined,
            dryRun: !!config.dryRun,
            path: options.changelogPath || config.changelogPath,
            // Allow forcing full history via --since ""
            sinceRef: emptySinceToNull(options.since) ?? emptySinceToNull(config.changelogSince) ?? undefined,
          });
          s.stop(result.written ? `Updated ${result.path}` : 'Changelog preview');
          if (result.preview) {
            p.note(result.preview, 'Preview');
          } else {
            p.note(`Path: ${result.path}`, 'Changelog');
          }
          p.outro(pc.green('Done'));
          process.exit(0);
        } catch (err: any) {
          s.stop('Failed to generate changelog');
          p.outro(pc.red(err?.message || String(err)));
          process.exit(1);
        }
      }

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
      let regen = 0;

      const generateNew = async () => {
        const gen = p.spinner();
        gen.start(`Generating with ${currentEngine}`);

        try {
          // Pass deterministic regen counter for variation
          config.regen = regen;
          candidates = await generateCandidates(changes, config);
          gen.stop('Generated 3 options');
        } catch (err) {
          if (currentEngine === 'ollama') {
            gen.stop('Ollama unavailable, using heuristic fallback');
            currentEngine = 'none';
            config.engine = 'none';
            config.regen = regen;
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

      // Helper: allow quick single-key shortcuts while select is open
      async function selectWithShortcuts(options: { label: string; value: string }[]) {
        // Allow aborting the prompt when a shortcut is pressed
        const ac = new AbortController();
        const selectPromise = p.select({
          message: 'Choose a commit message:',
          options,
          // @ts-ignore - signal is supported at runtime in clack
          signal: ac.signal as any,
        }) as Promise<string | symbol>;
        // Race it against a raw keypress listener for 1/2/3/r/p/q
        const keyPromise = new Promise<string>((resolve) => {
          const handler = (chunk: Buffer) => {
            const str = chunk.toString();
            // Only react to single, printable characters
            const key = str.length === 1 ? str : '';
            if (key && ['1', '2', '3', 'r', 'p', 'q'].includes(key)) {
              // Detach listener and resolve immediately
              process.stdin.off('data', handler);
              // Abort the active select so it stops listening
              try { ac.abort(); } catch { }
              resolve(key);
            }
          };
          process.stdin.on('data', handler);
          // Ensure cleanup if the select completes first
          // Avoid keeping the listener around across iterations
          selectPromise.finally(() => {
            try { process.stdin.off('data', handler); } catch { }
          });
        });
        // Whichever happens first wins
        // Avoid unhandled rejection if aborted by keypress
        selectPromise.catch(() => { });
        const result = await Promise.race([selectPromise, keyPromise]);
        return result as string | symbol;
      }

      while (running) {
        const previewMessages = candidates.map((msg, i) => {
          const full = prefix + msg;
          const len = full.length;
          const limit = typeof config.maxLen === 'number' && config.maxLen > 0 ? config.maxLen : null;
          const indicator = !limit || len <= limit ? pc.green('✓') : pc.yellow('⚠');
          const lengthLabel = limit ? `(${len}/${limit} chars)` : `(${len} chars)`;
          return `${indicator} ${i + 1}. ${pc.bold(full)} ${pc.dim(lengthLabel)}`;
        });

        const action = await selectWithShortcuts([
          { value: '1', label: previewMessages[0] },
          { value: '2', label: previewMessages[1] },
          { value: '3', label: previewMessages[2] },
          { value: 'r', label: pc.cyan('↻ Regenerate new options') },
          { value: 'p', label: pc.magenta('✎ Set/change prefix') },
          { value: 'q', label: pc.red('✕ Quit without committing') },
        ]);

        if (p.isCancel(action) || action === 'q') {
          p.outro(pc.yellow('Cancelled'));
          process.exit(0);
        }

        if (action === 'r') {
          regen += 1;
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
