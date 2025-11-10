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

# Run gac
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

## Options

```bash
gac --prefix "JIRA-123: "   # Add prefix to all messages
gac --style conv             # Only Conventional Commits format
gac --engine none            # Use heuristic (no LLM)
gac --model llama3.2:3b      # Use different Ollama model
gac --dry-run                # Preview without committing
```

## Configuration

Create \`.gacrc\` in your project:

```json
{
  "engine": "ollama",
  "model": "mistral:7b",
  "style": "mix",
  "maxLen": 72
}
```

Or add to \`package.json\`:

```json
{
  "gac": {
    "style": "conv",
    "prefix": "feat: "
  }
}
```

## Auto-prefix from branch

If your branch is named \`feature/ABC-123-something\`, gac will automatically detect and suggest \`ABC-123: \` as the prefix.

## Engines

- **ollama** (default) - Free, local, private. Requires [Ollama](https://ollama.ai) installed
- **none** - Smart heuristic-based generation (no LLM needed)
- **openai** - Requires \`OPENAI_API_KEY\` env var (not implemented in MVP)
- **anthropic** - Requires \`ANTHROPIC_API_KEY\` env var (not implemented in MVP)

## Installing Ollama

```bash
# macOS/Linux
curl -fsSL https://ollama.ai/install.sh | sh

# Or download from https://ollama.ai

# Pull a model
ollama pull mistral:7b
```

## Why gac?

- Most commit message generators require paid API keys
- Many produce verbose, multi-line messages
- gac keeps it **short** (≤72 chars), **structured**, and **scannable**
- Perfect for teams using Conventional Commits or changelog automation

## License

MIT