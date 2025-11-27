import { execa } from 'execa';

export interface StagedChanges {
  hasStagedFiles: boolean;
  fileCount: number;
  diff: string;
  files: FileChange[];
  branch: string;
  repoName: string;
}

export interface FileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C';
  additions: number;
  deletions: number;
  summary: string;
}

export async function getStagedChanges(): Promise<StagedChanges> {
  // Check for staged files
  const { stdout: statusOut } = await execa('git', ['diff', '--cached', '--name-status']);
  
  if (!statusOut.trim()) {
    return {
      hasStagedFiles: false,
      fileCount: 0,
      diff: '',
      files: [],
      branch: '',
      repoName: '',
    };
  }

  // Get branch name
  const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  
  // Get repo name
  let repoName = 'repo';
  try {
    const { stdout: remoteUrl } = await execa('git', ['config', '--get', 'remote.origin.url']);
    const match = remoteUrl.match(/\/([^\/]+?)(\.git)?$/);
    if (match) repoName = match[1];
  } catch {
    // No remote, use directory name
    const { stdout: toplevel } = await execa('git', ['rev-parse', '--show-toplevel']);
    repoName = toplevel.split('/').pop() || 'repo';
  }

  // Get detailed diff
  const { stdout: diff } = await execa('git', ['diff', '--cached', '--unified=3']);
  
  // Parse file changes
  const files = await parseFileChanges(statusOut);

  return {
    hasStagedFiles: true,
    fileCount: files.length,
    diff,
    files,
    branch,
    repoName,
  };
}

async function parseFileChanges(nameStatus: string): Promise<FileChange[]> {
  const lines = nameStatus.trim().split('\n');
  const files: FileChange[] = [];

  for (const line of lines) {
    const [status, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');

    // Get stats for this file
    try {
      const { stdout: stats } = await execa('git', [
        'diff',
        '--cached',
        '--numstat',
        '--',
        path,
      ]);
      
      const [additions, deletions] = stats.split('\t').map(n => parseInt(n) || 0);
      
      // Get a brief summary of changes
      const { stdout: fileDiff } = await execa('git', [
        'diff',
        '--cached',
        '--unified=0',
        '--',
        path,
      ]);

      const summary = summarizeFileDiff(fileDiff, path);

      files.push({
        path,
        status: status[0] as any,
        additions,
        deletions,
        summary,
      });
    } catch {
      files.push({
        path,
        status: status[0] as any,
        additions: 0,
        deletions: 0,
        summary: '',
      });
    }
  }

  return files;
}

function summarizeFileDiff(diff: string, path: string): string {
  const lines = diff.split('\n');
  const added: string[] = [];
  const removed: string[] = [];

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push(line.slice(1).trim());
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed.push(line.slice(1).trim());
    }
  }

  // Extract key identifiers (function/class/const names)
  const identifiers = new Set<string>();
  const patterns = [
    /\b(?:function|class|const|let|var|interface|type|enum)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    /\bdef\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, // Python
    /\bfunc\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, // Go
  ];

  [...added, ...removed].forEach(line => {
    patterns.forEach(pattern => {
      const matches = line.matchAll(pattern);
      for (const match of matches) {
        identifiers.add(match[1]);
      }
    });
  });

  const ids = Array.from(identifiers).slice(0, 5);
  return ids.length > 0 ? ids.join(', ') : '';
}

export async function commitWithMessage(message: string): Promise<void> {
  await execa('git', ['commit', '-m', message]);
}

export async function stageAllTrackedFiles(): Promise<void> {
  await execa('git', ['add', '-u']);
}