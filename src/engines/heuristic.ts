import type { StagedChanges } from "../git.js";
import type { Config } from "../config.js";

interface ExtractedEntities {
  functions: string[];
  classes: string[];
  components: string[];
  variables: string[];
  dependencies: string[];
  hasErrorHandling: boolean;
}

/**
 * Performs a lightweight parse of the diff to find key code entities.
 */
function extractKeyEntities(diff: string, files: any[]): ExtractedEntities {
  const entities = {
    functions: new Set<string>(),
    classes: new Set<string>(),
    components: new Set<string>(),
    variables: new Set<string>(),
    dependencies: new Set<string>(),
  };
  let hasErrorHandling = false;

  const lines = diff.split("\n");

  const patterns = {
    function: /^\+\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/,
    arrowFunction:
      /^\+\s*(?:export\s+)?(?:const|let)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async)?\s*\(/,
    class: /^\+\s*(?:export\s+)?class\s+([a-zA-Z0-9_]+)/,
    component:
      /^\+\s*(?:export\s+)?(?:const\s+([A-Z][a-zA-Z0-9_]+)\s*=|function\s+([A-Z][a-zA-Z0-9_]+))/,
    variable: /^\+\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=[^>]/,
    pyFunction: /^\+\s*def\s+([a-zA-Z0-9_]+)/,
    pyClass: /^\+\s*class\s+([a-zA-Z0-9_]+)/,
    errorHandling: /^\+\s*.*\b(try\s*\{|catch\s*\(|throw\s+new\s+Error)/,
  };

  for (const line of lines) {
    let match;
    if ((match = line.match(patterns.component))) {
      entities.components.add(match[1] || match[2]);
      continue;
    }
    if ((match = line.match(patterns.function))) {
      entities.functions.add(match[1]);
    }
    if ((match = line.match(patterns.arrowFunction))) {
      if (!/^[A-Z]/.test(match[1])) {
        entities.functions.add(match[1]);
      }
    }
    if ((match = line.match(patterns.class))) {
      entities.classes.add(match[1]);
    }
    if ((match = line.match(patterns.variable))) {
      entities.variables.add(match[1]);
    }
    if ((match = line.match(patterns.pyFunction))) {
      entities.functions.add(match[1]);
    }
    if ((match = line.match(patterns.pyClass))) {
      entities.classes.add(match[1]);
    }
    if (line.match(patterns.errorHandling)) {
      hasErrorHandling = true;
    }
  }

  const pkgJsonFile = files.find((f) => f.path.endsWith("package.json"));
  if (pkgJsonFile) {
    const fileDiff = getDiffForFile(diff, "package.json");
    const diffLines = fileDiff.split("\n");
    let inDepsBlock = false;
    for (const line of diffLines) {
      // This heuristic tracks whether the current context of the diff is inside a
      // dependencies block. It resets when it sees another common top-level key.
      const contentLine = line.startsWith(" ") ? line.slice(1) : line;
      if (
        /^"((dev|peer|optional)?[dD]ependencies|scripts|engines|files|exports|imports)"/.test(
          contentLine.trim()
        )
      ) {
        inDepsBlock = /dependencies/i.test(contentLine);
      }

      if (inDepsBlock && line.startsWith("+")) {
        const depMatch = line.match(/^\+\s*"([^"]+)"\s*:/);
        if (depMatch) {
          entities.dependencies.add(depMatch[1]);
        }
      }
    }
  }

  return {
    functions: Array.from(entities.functions),
    classes: Array.from(entities.classes),
    components: Array.from(entities.components),
    variables: Array.from(entities.variables),
    dependencies: Array.from(entities.dependencies),
    hasErrorHandling,
  };
}

export async function generateHeuristic(
  changes: StagedChanges,
  config: Config
): Promise<string[]> {
  const { files } = changes;
  const variant = config.regen ?? 0;

  const entities = extractKeyEntities(changes.diff, files);
  const docsFiles = files.filter((f) => isDocFile(f.path));
  const codeFiles = files.filter((f) => !isDocFile(f.path));
  const codeDiff = buildDiffForFiles(changes.diff, codeFiles);

  const baseFiles = codeFiles.length ? codeFiles : files;
  const baseDiff = codeFiles.length ? codeDiff : changes.diff;

  const primaryFocus = detectPrimaryFocus(baseFiles, baseDiff);
  const type = detectChangeType(baseFiles, baseDiff, entities, primaryFocus);
  const scope = detectScope(files);

  const docTopic = extractDocsTopic(buildDiffForFiles(changes.diff, docsFiles));
  const docWeight = docsFiles.reduce(
    (s, f) => s + Math.max(1, (f.additions || 0) + (f.deletions || 0)),
    0
  );
  const codeWeight = codeFiles.reduce(
    (s, f) => s + Math.max(1, (f.additions || 0) + (f.deletions || 0)),
    0
  );

  const isArchitecturalChange = [
    "engine-refactor",
    "new-engine",
    "multi-engine",
    "core-refactor",
  ].includes(primaryFocus.focus);
  const docsThreshold = isArchitecturalChange ? 0.6 : 0.4;
  const docsSignificant =
    docsFiles.length > 0 &&
    (codeFiles.length === 0 ||
      docWeight >= Math.ceil((codeWeight + docWeight) * docsThreshold));

  const allDescriptions = buildDescriptions(
    files,
    type,
    primaryFocus,
    scope,
    entities,
    variant
  );
  if (allDescriptions.length === 0) {
    allDescriptions.push({ verb: "update", noun: "files" });
  }

  // On each regeneration, cycle which description is considered primary.
  const primaryIndex = variant % allDescriptions.length;
  // Reorder the array so the current primary is first.
  const descriptions = [
    allDescriptions[primaryIndex],
    ...allDescriptions.slice(0, primaryIndex),
    ...allDescriptions.slice(primaryIndex + 1),
  ];

  const selectedDesc = descriptions[0];

  const candidates: string[] = [];
  const isMixed = codeFiles.length > 0 && docsSignificant;

  // Build 3 diverse candidates based on style
  if (config.style === "conv" || config.style === "mix") {
    if (isMixed) {
      const codeType = type;
      const codeScope = detectScope(codeFiles) || scope;
      const docsScope = docsFiles.some((f) => /README\.md$/i.test(f.path))
        ? "readme"
        : "";
      const left = `${codeType}${codeScope ? `(${codeScope})` : ""}: ${
        selectedDesc.noun
      }`;
      const docsPhrase =
        docTopic || (docsScope === "readme" ? "README" : "docs");
      const right = `docs${
        docsScope ? `(${docsScope})` : ""
      }: update ${docsPhrase}`;
      candidates.push(`${left}; ${right}`);
    } else {
      const finalType = docsSignificant ? "docs" : type;
      const finalScope = docsSignificant
        ? detectScope(docsFiles) || "docs"
        : scope;
      const finalNoun = docsSignificant
        ? docTopic || "documentation"
        : selectedDesc.noun;
      const scopePart = finalScope ? `(${finalScope})` : "";
      candidates.push(`${finalType}${scopePart}: ${finalNoun}`);
    }
  }

  if (config.style === "plain" || config.style === "mix") {
    if (isMixed) {
      const docsScope = docsFiles.some((f) => /README\.md$/i.test(f.path))
        ? "README"
        : "docs";
      const right = `${pickVerb("docs", "docs", variant)} ${
        docTopic
          ? docsScope === "README"
            ? `README ${docTopic}`
            : docTopic
          : docsScope
      }`;
      candidates.push(
        `${capitalizeFirst(selectedDesc.verb)} ${
          selectedDesc.noun
        } and ${right}`
      );
    } else {
      const finalVerb = docsSignificant
        ? pickVerb("docs", "docs", variant)
        : selectedDesc.verb;
      const finalNoun = docsSignificant
        ? docTopic || "documentation"
        : selectedDesc.noun;
      candidates.push(capitalizeFirst(`${finalVerb} ${finalNoun}`));
    }
  }

  if (config.style === "gitmoji" || config.style === "mix") {
    const finalType = docsSignificant ? "docs" : type;
    const emoji = getEmoji(finalType);
    if (isMixed) {
      const docsScope = docsFiles.some((f) => /README\.md$/i.test(f.path))
        ? "README"
        : "docs";
      const left = `${getEmoji(type)} ${selectedDesc.verb} ${
        selectedDesc.noun
      }`;
      const right = `📝 ${pickVerb("docs", "docs", variant)} ${
        docTopic
          ? docsScope === "README"
            ? `README ${docTopic}`
            : docTopic
          : docsScope
      }`;
      candidates.push(`${left}; ${right}`);
    } else {
      const finalScope = docsSignificant
        ? detectScope(docsFiles) || "docs"
        : scope;
      const finalNoun = docsSignificant
        ? docTopic || "documentation"
        : selectedDesc.noun;
      const scopePart = finalScope ? `${finalScope}: ` : "";
      candidates.push(`${emoji} ${scopePart}${finalNoun}`);
    }
  }

  // Use other descriptions to generate genuinely different alternatives
  let altIndex = 1;
  while (candidates.length < 3 && altIndex < descriptions.length) {
    const altDesc = descriptions[altIndex];
    const altType = type; // Keep type consistent for alternatives

    let alt: string;
    if (config.style === "conv") {
      alt = `${altType}${scope ? `(${scope})` : ""}: ${altDesc.noun}`;
    } else if (config.style === "gitmoji") {
      alt = `${getEmoji(altType)} ${scope ? `${scope}: ` : ""}${altDesc.noun}`;
    } else {
      alt = capitalizeFirst(`${altDesc.verb} ${altDesc.noun}`);
    }

    if (!candidates.find((c) => c.endsWith(altDesc.noun))) {
      candidates.push(alt);
    }
    altIndex++;
  }

  // Final fallback if still not enough options
  while (candidates.length < 3) {
    candidates.push(`Update ${scope || "project"} files`);
  }

  return [...new Set(candidates)].slice(0, 3);
}

function detectPrimaryFocus(
  files: any[],
  diff: string
): {
  focus:
    | "new-engine"
    | "multi-engine"
    | "engine-refactor"
    | "core-refactor"
    | "deps"
    | "single-file"
    | "generic";
  detail: string;
} {
  const categories = categorizeFiles(files);
  const coreCategories = ["cli", "config", "git", "engine", "generator"].filter(
    (c) => categories.has(c)
  );
  if (coreCategories.length >= 3) {
    return {
      focus: "core-refactor",
      detail: `core components (${coreCategories.join(", ")})`,
    };
  }

  if (categories.has("dependencies") && categories.size === 1) {
    return { focus: "deps", detail: "dependencies" };
  }

  const engineFiles = files.filter((f) => /\/engines\//.test(f.path));
  if (engineFiles.length / files.length > 0.6) {
    const added = engineFiles.filter((f) => f.status === "A").length;
    const modified = engineFiles.length - added;
    if (added > 0 && modified > 0)
      return { focus: "engine-refactor", detail: "engine architecture" };
    if (added > 1) return { focus: "new-engine", detail: "multiple engines" };
    if (added === 1)
      return {
        focus: "new-engine",
        detail: `${engineFiles
          .find((f) => f.status === "A")
          ?.path.split("/")
          .pop()
          ?.replace(".ts", "")} engine`,
      };
    if (modified > 1)
      return { focus: "multi-engine", detail: "multiple engines" };
  }

  if (files.length === 1) {
    return {
      focus: "single-file",
      detail: files[0].path.split("/").pop() || "",
    };
  }

  return { focus: "generic", detail: "" };
}

function buildDescriptions(
  files: any[],
  type: string,
  primaryFocus: ReturnType<typeof detectPrimaryFocus>,
  scope: string,
  entities: ExtractedEntities,
  variant: number
): Array<{ verb: string; noun: string }> {
  const descriptions: Array<{ verb: string; noun: string }> = [];

  // 1. Primary subject from specific entities
  const primary = buildIntelligentSubject(
    type,
    scope,
    entities,
    files,
    variant
  );
  descriptions.push(primary);

  // 2. Focus-based description (if it's different)
  if (primaryFocus.focus !== "generic" && primaryFocus.detail) {
    const focusVerb = getVerbForFocus(primaryFocus.focus, type);
    if (primaryFocus.detail.toLowerCase() !== primary.noun.toLowerCase()) {
      descriptions.push({ verb: focusVerb, noun: primaryFocus.detail });
    }
  }

  // 3. Broader category-based description
  const catNoun = buildCategoryNoun(files);
  if (catNoun && catNoun.toLowerCase() !== primary.noun.toLowerCase()) {
    descriptions.push({
      verb: getDefaultVerb(type, variant + 1),
      noun: catNoun,
    });
  }

  // 4. File-count based description (as a fallback)
  if (files.length > 1) {
    const fallbackNoun = `${files.length} files`;
    if (fallbackNoun.toLowerCase() !== primary.noun.toLowerCase()) {
      descriptions.push({
        verb: getDefaultVerb(type, variant + 2),
        noun: fallbackNoun,
      });
    }
  }

  // De-duplicate based on the noun
  const uniqueNouns = new Set<string>();
  return descriptions.filter((d) => {
    if (!d.noun || uniqueNouns.has(d.noun.toLowerCase())) return false;
    uniqueNouns.add(d.noun.toLowerCase());
    return true;
  });
}

function buildIntelligentSubject(
  type: string,
  scope: string,
  entities: ExtractedEntities,
  files: any[],
  variant: number
): { verb: string; noun: string } {
  const verb = getDefaultVerb(type, variant);

  if (entities.dependencies.length > 0) {
    const deps = entities.dependencies;
    if (deps.length === 1)
      return { verb: "update", noun: `dependency ${deps[0]}` };
    if (deps.length <= 3)
      return { verb: "update", noun: `dependencies ${deps.join(", ")}` };
    return { verb: "update", noun: `${deps.length} dependencies` };
  }

  const newCount =
    entities.components.length +
    entities.classes.length +
    entities.functions.length;
  if (type === "feat" && newCount > 0) {
    if (entities.components.length > 0)
      return { verb: "add", noun: `${entities.components[0]} component` };
    if (entities.classes.length > 0)
      return { verb: "add", noun: `${entities.classes[0]} class` };
    if (entities.functions.length > 0)
      return { verb: "add", noun: `${entities.functions[0]} function` };
  }

  if (type === "refactor" && newCount > 0) {
    if (entities.components.length > 0)
      return { verb: "refactor", noun: `${entities.components[0]} component` };
    if (entities.classes.length > 0)
      return { verb: "refactor", noun: `${entities.classes[0]} class` };
    if (entities.functions.length > 0)
      return { verb: "refactor", noun: `${entities.functions[0]} function` };
  }

  if (type === "fix" && entities.functions.length > 0) {
    return { verb: "fix", noun: `error in ${entities.functions[0]} function` };
  }

  const catNoun = buildCategoryNoun(files);
  if (catNoun) {
    if (scope && catNoun.toLowerCase().includes(scope.toLowerCase())) {
      return { verb, noun: catNoun };
    }
    return { verb, noun: scope ? `${scope} ${catNoun}` : catNoun };
  }

  return { verb, noun: scope || "project" };
}

function getVerbForFocus(focus: string, type: string): string {
  if (focus.includes("refactor")) return "refactor";
  if (focus.includes("new-engine"))
    return type === "feat" ? "add" : "implement";
  if (focus === "multi-engine") return "update";
  if (focus === "deps") return "update";
  return getDefaultVerb(type, 0);
}

function detectChangeType(
  files: any[],
  diff: string,
  entities: ExtractedEntities,
  primaryFocus: ReturnType<typeof detectPrimaryFocus>
): string {
  if (files.every((f) => isDocFile(f.path))) return "docs";
  if (entities.dependencies.length > 0) return "chore";
  if (primaryFocus.focus.includes("refactor")) return "refactor";
  if (entities.hasErrorHandling) return "fix";

  const hasNewEntities =
    entities.functions.length > 0 ||
    entities.classes.length > 0 ||
    entities.components.length > 0;
  const addedCode = files.some((f) => f.status === "A" && !isDocFile(f.path));
  if (addedCode || hasNewEntities) return "feat";

  if (/\b(fix|bug|issue|patch|resolve[sd]?|correct)\b/i.test(diff))
    return "fix";
  if (files.some((f) => /\.test\.|_test\.|spec\.|__tests__/.test(f.path)))
    return "test";
  if (/\b(refactor|restructure|cleanup|simplify)\b/i.test(diff))
    return "refactor";
  if (files.some((f) => /\.(css|scss|less|styl)$/.test(f.path))) return "style";
  if (files.some((f) => /(package-lock|yarn\.lock)/.test(f.path)))
    return "chore";

  return "chore";
}

function detectScope(files: any[]): string {
  if (files.length === 0) return "";
  const paths = files.map((f) => f.path.replace(/\\/g, "/").toLowerCase());
  const weights = files.map((f) =>
    Math.max(1, (f.additions || 0) + (f.deletions || 0))
  );

  const domains: Record<string, RegExp> = {
    engine: /\b(engines|heuristic|ollama|openai|gemini)\b/,
    cli: /\b(cli|command|bin)\b/,
    api: /\b(api|endpoint|route)\b/,
    auth: /\b(auth|login|session)\b/,
    config: /\b(config|setting|env)\b/,
    ci: /\.github|\.gitlab/,
    ui: /\b(ui|components|views|pages)\b/,
  };

  const counts: Record<string, number> = {};
  for (const key in domains) {
    counts[key] = paths.reduce(
      (sum, path, i) => sum + (domains[key].test(path) ? weights[i] : 0),
      0
    );
  }

  const best = Object.keys(counts)
    .filter((k) => counts[k] > 0)
    .sort((a, b) => counts[b] - counts[a])[0];
  if (best) return best;

  if (files.length === 1) {
    const parts = paths[0].split("/").slice(0, -1);
    const meaningful = parts.filter((p: string) => !["src", "lib"].includes(p));
    return meaningful.pop() || "";
  }

  return "";
}

function buildCategoryNoun(files: any[]): string {
  const cats = categorizeFiles(files);
  if (cats.size === 0) return "";
  const entries = Array.from(cats.entries()).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 2).map(([k]) => k);
  const parts = top.map((k) => prettifyCategory(k)).filter(Boolean);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return "multiple components";
}

function prettifyCategory(category: string): string {
  const mapping: Record<string, string> = {
    engine: "engines",
    cli: "CLI",
    api: "API",
    ui: "UI",
    config: "configuration",
    ci: "CI",
    dependencies: "dependencies",
    git: "Git logic",
    generator: "generator",
  };
  return mapping[category] || category;
}

function categorizeFiles(files: any[]): Map<string, number> {
  const categories = new Map<string, number>();
  for (const file of files) {
    let category = "code";
    const path = file.path.replace(/\\/g, "/");
    const weight = Math.max(1, (file.additions || 0) + (file.deletions || 0));

    if (
      /(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)/.test(path)
    )
      category = "dependencies";
    else if (path.includes("/engines/")) category = "engine";
    else if (path.includes("/cli")) category = "cli";
    else if (path.includes("/git")) category = "git";
    else if (path.includes("/generator")) category = "generator";
    else if (/\.(tsx|jsx)$/.test(path)) category = "ui";
    else if (/\.test\.|\.spec\.|__tests__/.test(path)) category = "tests";
    else if (isDocFile(path)) category = "docs";
    else if (/api|route|endpoint/.test(path)) category = "api";
    else if (/config|settings/.test(path)) category = "config";

    categories.set(category, (categories.get(category) || 0) + weight);
  }
  return categories;
}

function getDiffForFile(fullDiff: string, filePath: string): string {
  const diffs = fullDiff.split(/^diff --git/m);
  const fileDiff = diffs.find((d) => d.includes(`b/${filePath}`));
  return fileDiff || "";
}

function buildDiffForFiles(diff: string, files: any[]): string {
  if (!diff || files.length === 0) return "";
  const wanted = new Set(files.map((f) => `b/${f.path.replace(/\\/g, "/")}`));
  const diffs = diff.split(/^diff --git/m);
  return diffs
    .filter((d) => wanted.has(d.split("\n")[0].split(" ")[2]))
    .join("diff --git");
}

function isDocFile(path: string): boolean {
  return /\.(md|txt|rst|adoc)$/i.test(path);
}

function extractDocsTopic(diff: string): string {
  if (!diff) return "";
  const headingMatch = diff.match(/^\+\s*#+\s*(.+)/m);
  if (headingMatch) return headingMatch[1].toLowerCase();
  if (/\binstall|setup\b/i.test(diff)) return "installation instructions";
  if (/\busage|command\b/i.test(diff)) return "usage examples";
  return "";
}

function pickVerb(
  type: string,
  domain: "code" | "docs",
  variant: number
): string {
  const pools: Record<string, string[]> = {
    docs: ["clarify", "update", "improve", "refine"],
    refactor: ["refactor", "simplify", "restructure"],
    chore: ["update", "maintain", "tune"],
    feat: ["add", "implement", "introduce"],
    fix: ["fix", "resolve", "correct"],
    test: ["test", "add tests for", "verify"],
    style: ["style", "format", "lint"],
    default: ["update", "improve", "modify"],
  };
  const key =
    domain === "docs"
      ? "docs"
      : Object.keys(pools).includes(type)
      ? type
      : "default";
  const pool = pools[key];
  return pool[variant % pool.length];
}

function getDefaultVerb(type: string, variant: number): string {
  return pickVerb(type, "code", variant);
}

function getEmoji(type: string): string {
  const emojis: Record<string, string> = {
    feat: "✨",
    fix: "🐛",
    docs: "📝",
    style: "💄",
    refactor: "♻️",
    test: "✅",
    chore: "🔧",
    perf: "⚡️",
    build: "📦",
    ci: "👷",
  };
  return emojis[type] || "🔨";
}

export function capitalizeFirst(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
