# OpenWiki Documentation Plan

## Repository Overview
- OpenWiki is a CLI tool that generates and maintains agent-friendly documentation for codebases
- Built on DeepAgents framework
- Supports multiple LLM providers (OpenRouter, Anthropic, OpenAI, Fireworks, Baseten, AWS Bedrock, OpenAI-compatible)
- Creates documentation in `openwiki/` directory within target repositories
- Can run in three modes: chat, init, update

## Key Source Evidence
- README.md: User-facing documentation, installation, usage
- package.json: npm package config, dependencies, scripts
- CONTRIBUTING.md: PR guidelines, development process
- DEVELOPMENT.md: Local development setup
- src/cli.tsx: Main CLI interface (77KB - needs targeted reading)
- src/agent/: Agent core logic
  - index.ts: Main agent runner, model initialization
  - prompt.ts: System prompts for different modes
  - types.ts: Type definitions
  - utils.ts: Update noop detection, context creation
- src/commands.ts: CLI argument parsing
- src/constants.ts: Provider configs, model options
- src/credentials.tsx: Interactive credential setup (React/Ink)
- src/env.ts: Environment variable management
- test/: Comprehensive test suite

## Intended Wiki Pages

### 1. quickstart.md (Required entrypoint)
- What OpenWiki is and does
- Installation and basic usage
- Three modes: init, update, chat
- Provider and model configuration
- CI/CD integration overview
- Links to all other sections

### 2. architecture/overview.md
- High-level architecture
- DeepAgents integration
- Virtual filesystem approach
- Checkpoint-based memory
- LangGraph streaming
- Model/provider abstraction

### 3. workflows/documentation-generation.md
- Init mode workflow
- Update mode workflow (with noop detection)
- Chat mode workflow
- Git-based change detection
- Planning discipline (_plan.md temporary file)

### 4. domain/providers-and-models.md
- Provider configuration system
- Supported providers and their models
- Base URL customization
- Region requirements (AWS Bedrock)
- API key management

### 5. operations/configuration.md
- ~/.openwiki/.env management
- Environment variables reference
- Credential storage and security
- Debug mode (OPENWIKI_DEV)

### 6. testing/test-suite.md
- Test structure
- Command parsing tests
- Credential tests
- Update noop detection tests
- Environment variable tests

### 7. development/contributing.md (synthesis of CONTRIBUTING.md + DEVELOPMENT.md)
- Local development setup
- Testing and running locally
- PR standards and expectations
- One PR = one change rule

## Source Maps
- Each page will have inline source references where relevant
- No separate source map pages needed (repository is small enough)

## Key Behaviors to Document
- Update noop detection (compares git HEAD and content snapshot)
- Thread ID persistence for conversation memory
- Interactive credential setup flow
- OpenRouter response sanitization for HTML tokens
- Virtual filesystem mode (rootDir mapping)
- AGENTS.md/CLAUDE.md auto-updating

## Questions/Notes
- Large cli.tsx file (77KB) - will need targeted reading of key sections
- credentials.tsx uses Ink (React for CLIs) - interesting React-based terminal UI
- Strong security posture: sanitization, least-privilege CI, supply chain protection
- Recent focus: tool schema recovery middleware, non-interactive mode for CI
