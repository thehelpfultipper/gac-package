# gac - Git Auto Commit

Smart, succinct Git commit messages - **free & local-first**

## Quick Start

```bash
# Install globally
npm install -g gac

# Or try without installing
npx gac
```

## Usage

```bash
# Stage your changes
git add .

# Run gac (uses Ollama by default, falls back to heuristic if unavailable)
gac

# That's it! Choose from 3 AI-generated options
```

## Features

- 🆓 **Free by default** - Uses local Ollama (no API costs)
- 🔒 **Privacy-first** - Code never leaves your machine
- 🎯 **Smart fallback** - Works without any LLM installed
- ⚡ **Fast** - Generates 3 options in seconds
- 📏 **Convention-aware** - Supports Conventional Commits, Gitmoji, plain style
- 🎨 **Interactive** - Choose, regenerate, or customize on the fly

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
If your branch is named like \`feature/ABC-123-add-auth\`, gac automatically detects and suggests \`ABC-123: \` as the prefix.

### Model Selection (Ollama)

**Important:** If using a model other than the default (\`mistral:7b\`), you **must** specify it:

```bash
# Via command flag
gac --model llama3.2:3b

# Via environment variable
export GAC_MODEL="llama3.2:3b" && gac

# Via config file (see Configuration section)
```

**Recommended models** (fastest to slowest):
- \`llama3.2:3b\` - Fastest, great for quick commits
- \`phi3:3.8b\` - Fast, good quality
- \`mistral:7b\` - Default, balanced speed/quality
- \`llama3.1:8b\` - Slower but high quality

### Length Control

```bash
gac --max-len 50     # Shorter messages (default: 72)
gac --max-len 100    # Longer messages (not recommended)
```

### Complete Flag Reference

| Flag | Description | Default |
|------|-------------|---------|
| `--prefix <text>` | Prefix for all messages | `""` (auto-detect from branch) |
| `--style <type>` | Message style: plain \| conv \| gitmoji \| mix | `mix` |
| `--engine <name>` | Engine: ollama \| openai \| anthropic \| none | `ollama` |
| `--model <name>` | Ollama model name | `mistral:7b` |
| `--max-len <num>` | Max subject line length | `72` |
| `--dry-run` | Preview without committing | `false` |

## Engine Behavior

### Default Behavior (Ollama with Automatic Fallback)

When you run `gac` without specifying an engine:

1. **Tries Ollama first** - Attempts to connect to `http://127.0.0.1:11434`
2. **Auto-falls back to heuristic** - If Ollama is unavailable/not running
3. **No error shown** - Seamless fallback with a notice: "Ollama unavailable, using heuristic fallback"

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

### Paid Engines (Not in MVP)

```bash
# Requires OPENAI_API_KEY environment variable
gac --engine openai

# Requires ANTHROPIC_API_KEY environment variable
gac --engine anthropic
```

**Note:** OpenAI and Anthropic engines are placeholders in the MVP. Use `--engine ollama` or `--engine none`.

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

1. Default values
2. `.gacrc` file
3. `package.json` `"gac"` field
4. Environment variables (`GAC_PREFIX`, `GAC_MODEL`)
5. Command-line flags (highest priority)

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

When you run `gac`, you'll see an interactive menu:

```
? Choose a commit message:
  ✓ 1. feat(auth): add session refresh on 401 response (50 chars)
  ✓ 2. Add session refresh on 401 response (38 chars)
  ⚠ 3. ✨ auth: implement automatic session refresh (73 chars)
  ↻ Regenerate new options
  ✎ Set/change prefix
  ✕ Quit without committing
```

**Keys:**
- **1, 2, 3** - Select that option and commit
- **r** - Regenerate 3 new options
- **p** - Add/change prefix (e.g., add ticket number)
- **q** - Quit without committing

**Indicators:**
- ✓ Green checkmark - Under 72 characters (good)
- ⚠ Yellow warning - Over 72 characters (consider regenerating)

## Examples

### Example 1: Quick commit with auto-prefix

```bash
# On branch: feature/PROJ-456-add-login
git add src/auth/login.ts
gac
# Auto-detects "PROJ-456: " prefix
# Shows: "PROJ-456: feat(auth): add login form validation"
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

## License

MIT