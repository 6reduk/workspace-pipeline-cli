# Owned configuration fields

S11 development: setup includes Codex, Claude, Kimi and Grok adapters.

Trusted adapters propose changes; this layer does not grant approval, install a
plugin, start a harness/MCP server or edit any global configuration.

## JSON and TOML

JSON field requests retain their existing JSON-pointer ownership semantics.
Claude's root `.mcp.json` is restricted to individual named `/mcpServers/<name>`
entries. Whole-file replacement and taking over the entire server map are refused.
Kimi's `.kimi-code/mcp.json` has the same named-entry restriction. JSON output is
reserialized with two-space indentation and a final newline: foreign values are
preserved, but the original JSON whitespace is not promised.

Codex `.codex/config.toml` uses `toml-fields` requests. Only named `/agents/<name>`
and `/mcp_servers/<name>` entries are addressable. Reserved scalar agent settings,
model, auth, permissions and project trust are outside this editor's scope.
Format is selected by this exact destination, never by executable source code or
a heuristic based on the file's contents. Existing state kind `field` and hashes
remain format-independent; no document/pipeline semantic version gate is added.
Grok's exact `.grok/config.toml` destination also uses TOML, restricted to named
`/mcp_servers/<name>` entries. Its agents are separate Markdown files. Compatibility
flags are child-environment launch settings, not owned TOML edits.

An entry is owned as a whole object. Concurrent changes inside that object cause
a conflict, including extra fields; foreign sibling entries remain foreign.
Equal foreign values do not silently become owned. Exact explicit takeover still
requires the ordinary preview/apply approval and backup.

## Preservation and limits

TOML is parsed as TOML 1.0 using pinned `toml-eslint-parser` 0.10.1. AST source
ranges select changed entries; unrelated text, comments and newline spelling are
not reserialized. Changed entries are rendered deterministically and reparsed;
full semantic comparison checks that foreign values stayed unchanged. Comments
outside the replaced key/value spans stay in place, even if the former section
was removed. Empty lines/implicit parent tables may remain after removal.

- 2 MiB input/output and bounded AST traversal (50000 nodes, depth 64).
- Owned values must be JSON-domain TOML values; null/dates/nonfinite/unsafe numbers
  are refused. Foreign TOML values are preserved without conversion to JSON.
- Named entries may use dotted keys, quoted keys and ordinary nested sections.
- An inline ancestor such as `agents = { ... }` cannot be split while preserving
  foreign source spans: a changing request returns `toml.inline-ancestor`.
- Array-of-table entries and scalar parents are not supported owned entries.
- Parser diagnostics expose stable codes, not excerpts that may contain secrets.

Planner, doctor, repair, removal, backup checking and field-only historical
projections use the same destination codec. Repair uses installed snapshot data,
not latest upstream. The transaction engine still binds the exact complete
before/after file bytes and stops on drift; field projections do not authorize
continuation of uncertain operations.

## Evidence boundary

Unit tests cover text preservation and conflicts. Synthetic lifecycle tests cover
setup/update/doctor/repair/remove and original-value backup restoration. This does
not certify native runtime behavior, MCP startup or model-visible instruction
loading. All four compiled adapters are implemented; bounded native discovery
evidence and its limitations are recorded separately.

Parser source/API: [toml-eslint-parser](https://github.com/ota-meshi/toml-eslint-parser)
and [AST range specification](https://github.com/ota-meshi/toml-eslint-parser/blob/main/docs/AST.md).
