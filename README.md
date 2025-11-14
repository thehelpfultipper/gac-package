<div align="center">
  <img src="./assets/banner.svg" alt="gac - Git Auto Commit banner" />
</div>

# gac - Git Auto Commit

Smart, succinct Git commit messages - **free & local-first**

## Quick Start

```bash
# Install globally
npm install -g @thehelpfultipper/gac

# Or try without installing
npx @thehelpfultipper/gac
```

## Usage

```bash
# Stage your changes
git add .

# Run gac (uses Ollama by default, falls back to heuristic if unavailable)
gac

# That's it! Choose an option, edit if needed, and commit.
```

## Features

- 🆓 **Free by default** - Uses local Ollama (no API costs)
- 🔒 **Privacy-first** - Code never leaves your machine
- 🎯 **Smart fallback** - Works without any LLM installed
- ⚡ **Fast** - Generates 3 options in seconds
- 📏 **Convention-aware** - Supports Conventional Commits, Gitmoji, plain style
- 🎨 **Interactive** - Choose, edit, regenerate, or customize on the fly

## Command Options

### Basic Usage

```bash
gac                          # Uses Ollama (default), auto-falls back to heuristic
gac --engine none            # Force heuristic mode (no LLM)
gac --engine ollama          # Explicitly use Ollama
gac --dry-run                # Preview without committing
```

### Styling Options

The `--style` flag controls what format the commit messages use:

```bash
gac --style mix       # Default: 3 diverse formats (recommended)
gac --style conv      # Only Conventional Commits format
gac --style plain     # Only plain imperative format
gac --style gitmoji   # Only gitmoji format
```

**Example outputs for each style:**

**`--style mix`** (default - 3 different formats):
```
1. feat(auth): add session refresh on 401 response
2. Add session refresh on 401 response
3. ✨ auth: add session refresh on 401 response
```

**`--style conv`** (Conventional Commits only):
```
1. feat(auth): add session refresh on 401 response
2. fix(auth): handle expired tokens correctly
3. refactor(auth): simplify token validation logic
```

**`--style plain`** (plain imperative only):
```
1. Add session refresh on 401 response
2. Handle expired tokens correctly
3. Simplify token validation logic
```

**`--style gitmoji`** (emoji-prefixed only):
```
1. ✨ add session refresh on 401 response
2. 🐛 handle expired tokens correctly
3. ♻️ simplify token validation logic
```

### Prefix Options

Add a prefix to all generated messages (useful for ticket tracking):

```bash
gac --prefix "JIRA-123: "    # Manual prefix
export GAC_PREFIX="JIRA-123: " && gac  # Via environment variable
```

**Auto-detection from branch names:**
If your branch is named like `feature/ABC-123-add-auth`, gac automatically detects and suggests `ABC-123: ` as the prefix.

### Model Selection (Ollama)

**Important:** If using a model other than the default (`mistral:7b`), you **must** specify it:

```bash
# Via command flag
gac --model llama3.2:3b

# Via environment variable
export GAC_MODEL="llama3.2:3b" && gac

# Via config file (see Configuration section)
```

**Recommended models** (fastest to slowest):
- `llama3.2:3b` - Fastest, great for quick commits
- `phi3:3.8b` - Fast, good quality
- `mistral:7b` - Default, balanced speed/quality
- `llama3.1:8b` - Slower but high quality

### Length Control

```bash
gac --max-len 50     # Shorter messages (default: 72)
gac --max-len 100    # Longer messages (not recommended)
```

### Complete Flag Reference

| Flag                    | Description                                                      | Default                        |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------ |
| `--style <type>`        | Message style: `plain`, `conv`, `gitmoji`, or `mix`              | `mix`                          |
| `--engine <name>`       | Engine: `ollama`, `openai`, `gemini`, or `none`                   | `ollama`                       |
| `--model <name>`        | Model name (for Ollama, OpenAI, or Gemini)                       | `mistral:7b`                   |
| `--max-len <num>`       | Max subject line length                                          | `72`                           |
| `--dry-run`             | Preview without committing or releasing                          | `false`                        |
| `--prefix <text>`       | Prefix for commit message                                        | `""` (auto-detects from branch) |
| `--changelog [version]` | Generate/update `CHANGELOG.md` (optional version label)          | —                              |
| `--changelog-path <path>` | Override changelog file path                                     | auto-detect                    |
| `--since <ref>`         | Generate changelog since a specific Git ref (tag/commit)         | latest tag/heading             |
| `--release`             | Auto-bump version, update changelog, and create Git tag          | —                              |
| `--bump <level>`        | With `--release`, force bump: `patch`, `minor`, or `major`       | auto-detect                    |
| `--release-as <version>` | With `--release`, set exact version (e.g., `v1.2.3`)             | auto-detect                    |
| `--update-pkg`          | With `--release`, also update `package.json` version             | `false`                        |

## Engine Behavior

### Default Behavior (Ollama with Automatic Fallback)

When you run `gac` without specifying an engine:

1.  **Tries Ollama first** - Attempts to connect to `http://127.0.0.1:11434`
2.  **Auto-falls back to heuristic** - If Ollama is unavailable/not running
3.  **No error shown** - Seamless fallback with a notice: "Ollama unavailable, using heuristic fallback"

```bash
# These all behave the same way:
gac
gac --engine ollama
```

### Force Heuristic Mode

To skip Ollama entirely and use the rule-based heuristic:

```bash
gac --engine none
```

The heuristic mode is smart enough that many users prefer it over LLM generation - it's instant and produces high-quality conventional commits.

### OpenAI Engine

> Security warning:
> - Do not commit API keys to version control.
> - Prefer environment variables; if you use a local `.gacrc`, keep it out of git (this repo's `.gitignore` includes `.gacrc`).

```bash
# Requires OPENAI_API_KEY environment variable
export OPENAI_API_KEY=sk-... && gac --engine openai

# Specify a model (examples):
gac --engine openai --model gpt-4o-mini
gac --engine openai --model gpt-4o
```

Notes:
- If `--model` looks like an Ollama model (contains `:`), `gac` defaults to `gpt-4o-mini` for OpenAI.
 - The same prompt/formatting as Ollama is used; output is exactly 3 one-line subjects.
 - You can also store the key in config (see Configuration) as `openaiApiKey`.

### Gemini Engine

> Security warning:
> - Do not commit API keys to version control.
> - Prefer environment variables; if you use a local `.gacrc`, keep it out of git.

```bash
# Requires GEMINI_API_KEY or GOOGLE_API_KEY environment variable
export GEMINI_API_KEY=ya29... && gac --engine gemini

# Specify a model (examples):
gac --engine gemini --model gemini-1.5-flash
gac --engine gemini --model gemini-1.5-pro
```

Notes:
- If `--model` looks like an Ollama model (contains `:`), `gac` defaults to `gemini-1.5-flash` for Gemini.
- Same prompt/formatting as other engines; output is exactly 3 one-line subjects.
- You can also store the key in config (see Configuration) as `geminiApiKey`.

### Anthropic Engine (Placeholder)

The Anthropic engine is not implemented yet in this version.
Use `--engine ollama` or `--engine none` instead.

## Configuration

### Option 1: `.gacrc` file

Create `.gacrc` in your project root:

```json
{
  "engine": "ollama",
  "model": "llama3.2:3b",
  "style": "conv",
  "maxLen": 72,
  "prefix": ""
}
```

For OpenAI, you may include your API key (avoid committing this file):

```json
{
  "engine": "openai",
  "model": "gpt-4o-mini",
  "openaiApiKey": "sk-..."
}
```

For Gemini, you may include your API key (avoid committing this file):

```json
{
  "engine": "gemini",
  "model": "gemini-1.5-flash",
  "geminiApiKey": "ya29-..."
}
```

### Option 2: `package.json`

Add a `"gac"` field to your `package.json`:

```json
{
  "name": "my-project",
  "gac": {
    "style": "conv",
    "model": "phi3:3.8b",
    "engine": "ollama"
  }
}
```

### Configuration Priority

Settings are merged in this order (highest priority last):

1.  Default values
2.  `.gacrc` file
3.  `package.json` `"gac"` field
4.  Environment variables (`GAC_PREFIX`, `GAC_MODEL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`)
5.  Command-line flags (highest priority)

**Example:**
```bash
# .gacrc says model: "mistral:7b"
# But CLI flag overrides it:
gac --model llama3.2:3b  # Uses llama3.2:3b
```

## Installing Ollama

To use the default Ollama engine (these are bound to change, check website for updated installation instructions):

```bash
# macOS/Linux
curl -fsSL https://ollama.ai/install.sh | sh

# Windows
# Download from https://ollama.ai

# Start Ollama service
ollama serve

# Pull a model (in another terminal)
ollama pull mistral:7b
# or for faster generation:
ollama pull llama3.2:3b
```

### Keep Model Loaded for Speed

By default, Ollama unloads models after 5 minutes of inactivity. To keep them loaded:

```bash
export OLLAMA_KEEP_ALIVE=1h
ollama serve
```

## Interactive Mode

When you run `gac`, you'll see a two-step interactive menu.

### 1. Choose a Message

First, select a starting point from the generated options.

```
◇ Choose a commit message:

❯ ✓ 1. feat(auth): add session refresh on 401 response (50/72 chars)
  ✓ 2. Add session refresh on 401 response (38/72 chars)
  ⚠ 3. ✨ auth: implement automatic session refresh on token expiry (73/72 chars)
  ↻ Regenerate new options (r)
  ✎ Set/change prefix (p)
  ✕ Quit without committing (q)

  Use ↑/↓, Enter, or shortcuts (1-3, r, p, q)
```

**Keys:**
- **↑ / ↓** - Navigate options
- **1, 2, 3 / Enter** - Select an option to proceed to the edit/confirm step
- **r** - Regenerate 3 new options
- **p** - Add/change prefix (e.g., add ticket number)
- **q / Ctrl+C** - Quit without committing

**Indicators:**
- **✓** Green checkmark - Under 72 characters (good)
- **⚠** Yellow warning - Over 72 characters (consider regenerating)

### 2. Edit and Confirm

After selecting a message, you get a final chance to edit it before committing. This allows for quick tweaks or additions.

```
? Edit commit message: (Enter to commit, Ctrl+C to cancel)
❯ feat(auth): add session refresh and handle 401 response
```
- **Enter** - Confirms and commits the message.
- **Ctrl+C** - Cancels the edit and returns to the selection menu.

## Changelog & Releases

When to use which flag:

- `gac --changelog [version]`
  - Use to generate or update `CHANGELOG.md` without tagging.
  - Great for previewing (`--dry-run`) or preparing notes before a release.
  - If `version` is provided (e.g., `v1.2.3`), inserts/replaces that section.
  - If omitted, uses an “Unreleased - YYYY-MM-DD” heading and the latest tag as the “since” point.
  - Optional: `--since <ref>` to choose a custom starting point, and `--changelog-path` to write somewhere else (e.g., `docs/CHANGELOG.md`).

- `gac --release`
  - One step release: determines the next semver version from commits since the last tag, updates `CHANGELOG.md`, and creates an annotated Git tag (`vX.Y.Z`). If an `## Unreleased` section exists, it's automatically replaced by the new versioned section.
  - Prefer explicit control:
    - `--bump patch|minor|major` to increment from the last version
    - `--release-as vX.Y.Z` to set the exact target version
  - Use `--dry-run` to preview without writing anything.
  - Add `--update-pkg` to also bump `package.json`’s `version` to `X.Y.Z`.

Are these redundant?
- No. `--release` includes changelog generation but also handles bumping and tagging. `--changelog` is for manual or ad‑hoc changelog updates (preview, custom label/path/range) without touching tags or versions.

How versioning is determined (`--release`)
- Base version source: the most recent semver Git tag matching `vX.Y.Z`. If none, falls back to `package.json`’s `version` or `0.0.0`.
- You can control the target in three ways:
  - Explicit target: `--release-as vX.Y.Z`
  - Guided increment: `--bump patch|minor|major`
  - Auto (optional): If neither is provided, a simple Conventional-Commits-aware detection runs; if your commits aren’t conventional, it defaults to `patch`.
- Next version: tags as `vX.Y.Z` and optionally updates `package.json` with `--update-pkg`.

Changelog formatting basics
- Groups entries into sections (Breaking Changes, Added, Changed, Fixed, etc.).
- Adds date to headings; includes a repository compare link when possible.
- Detects breaking changes via `!` after type or `BREAKING CHANGE(S):` in body.

Examples
```bash
# Preview changelog entries since last tag without writing
gac --changelog --dry-run

# Generate/replace a specific section label (no tag)
gac --changelog v1.2.3

# Create a release: compute next version, update changelog, create tag (auto bump)
gac --release

# Also update package.json version
gac --release --update-pkg

# Explicit minor bump from last version
gac --release --bump minor

# Set exact version
gac --release --release-as v2.0.0

# Use a custom changelog path
gac --changelog --changelog-path docs/CHANGELOG.md

# Generate changes since a specific tag/commit
gac --changelog --since v1.0.0
```

### Example 1: Quick commit with auto-prefix

```bash
# On branch: feature/PROJ-456-add-login
git add src/auth/login.ts
gac
# Auto-detects "PROJ-456: " prefix
# Select an option, then confirm or edit the final message:
# ? Edit commit message: (Enter to commit)
# ❯ PROJ-456: feat(auth): add login form validation
```

### Example 2: Force specific style

```bash
git add .
gac --style conv --model llama3.2:3b
# All 3 options will be Conventional Commits format
# Using faster 3B model
```

### Example 3: Preview without committing

```bash
git add README.md
gac --dry-run --prefix "docs: "
# Shows what would be committed, but doesn't actually commit
```

### Example 4: Heuristic mode (no AI)

```bash
git add src/components/Button.tsx
gac --engine none
# Instant results using smart rule-based generation
```

## Why gac?

- Most commit message generators require paid API keys
- Many produce verbose, multi-line messages
- gac keeps it **short** (≤72 chars), **structured**, and **scannable**
- Perfect for teams using Conventional Commits or changelog automation
- Works offline with zero cost

## Troubleshooting

**"Ollama unavailable, using heuristic fallback"**
- Ollama isn't running - start with `ollama serve`
- Wrong model name - check available models with `ollama list`
- Port conflict - ensure 11434 is free

**"Nothing staged"**
- Run `git add <files>` before using gac

**Messages are too long**
- Use `--max-len 50` for shorter messages
- Regenerate until you get a shorter option

**Slow generation**
- Switch to smaller model: `--model llama3.2:3b`
- Keep model loaded: `export OLLAMA_KEEP_ALIVE=1h`
- Use `--engine none` for instant heuristic mode

**Secrets in config**
- Prefer environment variables for API keys in shared repos.
- If you store keys in `.gacrc`, add it to `.gitignore` so it isn’t committed.

## License

MIT
