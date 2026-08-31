## Purpose

Defines the IBM Bob coding agent as a supported host for OpenWiki MCP server installation — the config file paths, skill directory, and config adapter used when a user runs `openwiki install --host bob`.

## ADDED Requirements

### Requirement: Bob is a supported installation host

The system SHALL support `bob` as a valid `--host` argument to `openwiki install` and `openwiki uninstall`.

#### Scenario: Install command accepts bob as a host

- **WHEN** the user runs `openwiki install --host bob`
- **THEN** the command installs the OpenWiki MCP entry and skill bundle without an "unsupported host" error

#### Scenario: Invalid host rejected

- **WHEN** the user runs `openwiki install --host bob-typo`
- **THEN** the command exits with the same unsupported-host error it uses for other invalid values

---

### Requirement: User-scope installation targets ~/.bob/mcp.json

The system SHALL write the managed MCP entry to `~/.bob/mcp.json` when the `user` scope is selected for the Bob host.

#### Scenario: User-scope MCP entry installed

- **WHEN** `openwiki install --host bob` is run with user scope
- **THEN** `~/.bob/mcp.json` contains an `mcpServers.openwiki` entry with the correct command and args

---

### Requirement: Project-scope installation targets .bob/mcp.json

The system SHALL write the managed MCP entry to `.bob/mcp.json` relative to the project root when the `project` scope is selected.

#### Scenario: Project-scope MCP entry installed

- **WHEN** `openwiki install --host bob --project` is run from a Git repository
- **THEN** `.bob/mcp.json` in the repository root contains an `mcpServers.openwiki` entry

---

### Requirement: Bob skill bundle installs into the Bob skills directory

The system SHALL install the OpenWiki skill bundle into `.agents/skills/openwiki` under the selected scope root for the Bob host.

#### Scenario: Skill directory created on first install

- **WHEN** `openwiki install --host bob` is run and no prior skill bundle exists
- **THEN** the skill files are present under the expected `.agents/skills/openwiki` path

---

### Requirement: Bob integration status is queryable

The system SHALL report whether the Bob integration is `installed`, `modified`, or `not-installed` via the status command.

#### Scenario: Status reflects installed state

- **WHEN** `openwiki install --host bob` completes successfully
- **THEN** a subsequent status check for the Bob host reports `installed`

#### Scenario: Status reflects modified state

- **WHEN** the user edits the `mcpServers.openwiki` entry in `~/.bob/mcp.json` after installation
- **THEN** the status check for the Bob host reports `modified`
