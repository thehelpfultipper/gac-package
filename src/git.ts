import { execa } from "execa";
import { minimatch } from "minimatch";

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
  status: "A" | "M" | "D" | "R" | "C";
  additions: number;
  deletions: number;
  summary: string;
  isIgnored: boolean;
}

export async function getStagedChanges(
  ignoredPatterns: string[] = []
): Promise<StagedChanges> {
  // Check for staged files
  const { stdout: statusOut } = await execa("git", [
    "diff",
    "--cached",
    "--name-status",
  ]);

  if (!statusOut.trim()) {
    return {
      hasStagedFiles: false,
      fileCount: 0,
      diff: "",
      files: [],
      branch: "",
      repoName: "",
    };
  }

  // Get branch name
  let branch = "";
  try {
    const { stdout } = await execa("git", [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    branch = stdout.trim();
  } catch {
    // If this fails (e.g. empty repo with no commits), try getting the symbolic ref (unborn branch)
    try {
      const { stdout } = await execa("git", [
        "symbolic-ref",
        "--short",
        "HEAD",
      ]);
      branch = stdout.trim();
    } catch {
      branch = "HEAD";
    }
  }

  // Get repo name
  let repoName = "repo";
  try {
    const { stdout: remoteUrl } = await execa("git", [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    const match = remoteUrl.match(/\/([^\/]+?)(\.git)?$/);
    if (match) repoName = match[1];
  } catch {
    // No remote, use directory name
    try {
      const { stdout: toplevel } = await execa("git", [
        "rev-parse",
        "--show-toplevel",
      ]);
      repoName = toplevel.split("/").pop() || "repo";
    } catch {
      // Fallback if rev-parse fails
      repoName = "repo";
    }
  }

  // Get detailed diff
  const { stdout: diff } = await execa("git", [
    "diff",
    "--cached",
    "--unified=3",
  ]);

  // Parse file changes and mark ignored ones
  const files = await parseFileChanges(statusOut, ignoredPatterns);

  // Filter the full diff to remove chunks belonging to ignored files
  const filteredDiff = filterDiff(diff, files);

  return {
    hasStagedFiles: true,
    fileCount: files.length,
    diff: filteredDiff,
    files,
    branch,
    repoName,
  };
}

async function parseFileChanges(
  nameStatus: string,
  ignoredPatterns: string[]
): Promise<FileChange[]> {
  const lines = nameStatus.trim().split("\n");
  const files: FileChange[] = [];

  for (const line of lines) {
    const [status, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");

    // Check match
    const isIgnored = ignoredPatterns.some((pattern) =>
      minimatch(path, pattern)
    );

    // Get stats for this file
    try {
      const { stdout: stats } = await execa("git", [
        "diff",
        "--cached",
        "--numstat",
        "--",
        path,
      ]);

      const [additions, deletions] = stats
        .split("\t")
        .map((n) => parseInt(n) || 0);

      let summary = "";

      // Only generate summary for non-ignored files to save resources/tokens
      if (!isIgnored) {
        // Get a brief summary of changes
        const { stdout: fileDiff } = await execa("git", [
          "diff",
          "--cached",
          "--unified=0",
          "--",
          path,
        ]);

        const summary = summarizeFileDiff(fileDiff, path);
      }

      files.push({
        path,
        status: status[0] as any,
        additions,
        deletions,
        summary,
        isIgnored,
      });
    } catch {
      files.push({
        path,
        status: status[0] as any,
        additions: 0,
        deletions: 0,
        summary: "",
        isIgnored,
      });
    }
  }

  return files;
}

function filterDiff(fullDiff: string, files: FileChange[]): string {
  // Create a set of paths that should remain in the diff (not ignored)
  const allowedPaths = new Set(
    files.filter((f) => !f.isIgnored).map((f) => f.path)
  );

  if (allowedPaths.size === 0) return "";
  if (allowedPaths.size === files.length) return fullDiff;

  // Split diff into chunks. 'diff --git ' is the separator.
  // Note: split consumes the separator, so we'll need to re-add it.
  const chunks = fullDiff.split(/^diff --git /m);

  return chunks
    .map((chunk) => {
      if (!chunk.trim()) return "";

      // Extract the filename from the first line of the chunk
      // Header looks like: a/path/to/file b/path/to/file
      const firstLine = chunk.split("\n")[0];

      // Check if this chunk belongs to an allowed path
      // Git paths in header are usually a/path b/path, but strict checking can be complex with quoting.
      // We check if "a/<allowed>" or "b/<allowed>" is in the header.
      for (const path of allowedPaths) {
        if (firstLine.includes(path)) {
          return `diff --git ${chunk}`;
        }
      }
      return "";
    })
    .join("");
}

function summarizeFileDiff(diff: string, path: string): string {
  const lines = diff.split("\n");
  const added: string[] = [];
  const removed: string[] = [];

  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push(line.slice(1).trim());
    } else if (line.startsWith("-") && !line.startsWith("---")) {
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

  [...added, ...removed].forEach((line) => {
    patterns.forEach((pattern) => {
      const matches = line.matchAll(pattern);
      for (const match of matches) {
        identifiers.add(match[1]);
      }
    });
  });

  const ids = Array.from(identifiers).slice(0, 5);
  return ids.length > 0 ? ids.join(", ") : "";
}

export async function commitWithMessage(message: string): Promise<void> {
  await execa("git", ["commit", "-m", message]);
}

export async function stageAllTrackedFiles(): Promise<void> {
  await execa("git", ["add", "-u"]);
}
