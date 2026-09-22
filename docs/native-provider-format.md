# Native source components (S8 / S11 implementation)

These are trusted CLI adapters, not native harness plugins. They consume verified
Git files through the existing manifest component paths; source code is never
loaded as a CLI adapter. Development dispatch includes Codex, Claude, Kimi and Grok.
Harness discovery, packaged lifecycle and pilot readiness remain
separate checks.

## Skills

All four providers accept a directory of `<name>/SKILL.md` files. Each file has YAML
frontmatter containing exactly `name` and `description`, and a nonempty body.
Directory and declared name must match. Supporting files remain in the snapshot.
Names are lowercase ASCII letters/digits/hyphens, beginning with a letter, up to
63 characters; `constructor`, `prototype` and `default` are not accepted.

The CLI generates a small native skill in `.agents/skills/` (Codex) or
`.claude/skills/` (Claude). It retains the name/description and directs the agent
to read the complete source skill in the installed snapshot. Relative links are
resolved from that source file. This avoids rewriting the canonical procedure
and its links. Package authors must ensure those source-relative links resolve.
An existing foreign skill is an ownership conflict, not silently overwritten.
Names are not automatically changed: references in the pipeline keep working.
Authors should use a pipeline-specific prefix. User/global harness precedence
is not certified by file installation or these adapters.

## Agents

Codex: a flat directory of `<name>.toml`, with exactly three string assignments:
`name`, `description`, `developer_instructions`. The adapter registers named
roles in `.codex/config.toml`, pointing to local `.codex/agents/<name>.toml`.
Generated role files contain only `developer_instructions`, with source routing
followed by the original instruction text. No model or permission is selected.
The reserved scalar role name `enabled` is also rejected.

Claude: a flat directory of `<name>.md`, with exactly `name` and `description` in
YAML frontmatter and a nonempty instruction body. The generated
`.claude/agents/<name>.md` routes to the source. Optional harness-specific models,
tools, hooks and permission fields are currently unsupported and rejected, not
dropped silently. A null agents component explicitly means no packaged agents.

## MCP

Each non-null MCP component points to JSON with exactly `mcpServers`, a nonempty
map of named servers. Supported server shapes:

- `type: stdio`, `command`, optional string-array `args` and string-map `env`.
- `type: http`, `url` with HTTP(S), no userinfo or fragment.

Unknown fields/transports fail closed. There is no secret resolution, OAuth,
trust grant or server execution in rendering. Environment values are literal
configuration data; do not place secrets in public sources. Automatic startup
later remains harness behavior, and users must trust the pipeline supplier.

Codex receives individual `/mcp_servers/<name>` TOML fields; Claude receives
individual `/mcpServers/<name>` fields in wrapper `.mcp.json`. Other servers and
user settings retain existing ownership rules. Runtime availability is not
inferred from configuration presence.

## Entry and shared ownership

For a declared Claude/Grok bundle, [bundle rules](provider-bundles.md) take priority:
one full source-authored CLAUDE.md and joint lifecycle. The following neutral-entry
behavior is retained only for standalone sources without bundle declarations.

Claude and Grok share a provider-neutral `CLAUDE.md`: it imports `@AGENTS.md` and
explicitly instructs the reader to read AGENTS.md, without relying on import
syntax support in Grok. It contains no direct Claude-specific route. Normal
foreign-file conflict checks apply. Codex uses common `AGENTS.md`. Non-null provider
entry components are conditional routes from AGENTS.md; follow only the route for
the current harness. These links do not enable a provider.
The common entry lists available source routes independently of the selected
installation subset so removing one provider does not invalidate its remaining
owner's reconstruction. AGENTS.md remains until the last provider is removed.
CLAUDE.md has one shared owner but only two consumers: Claude and Grok. Removing
either retains it while the other remains; removing its final consumer restores
the original file or removes the created file, even if Codex remains installed.

An update migrates the old managed Claude-owned entry only after checking its
recorded bytes; original backup lineage is preserved. Edited or foreign files
remain conflicts, not implicitly authorized replacements. Installed version-1
adapter output can still be replayed for repair/removal before updating. Adapter
versions describe CLI rendering, never the validity of project documents.

Source contracts are intentionally bounded. `compatibility-isolation` is not a
claimed capability here. Legacy plugins/global imports require separate migration
and native checks; they are not disabled by these renderers.

## Official format references

- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex named agent/config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Claude subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude MCP scopes](https://code.claude.com/docs/en/mcp)

Consulted 2026-09-20/21. Native-version observations and limitations are recorded
in the S8 provider-discovery artifact; current docs alone do not certify installed
harness behavior.

## S11 development: Kimi and Grok components

These renderers are registered in the development CLI for configuration delivery.
Select providers in the workspace manifest, then use normal preview/apply setup.
Native discovery, trust and runtime isolation are separate from file installation.

Both use the same strict skill frontmatter and immutable routing described above:
Kimi writes `.kimi-code/skills/<name>/SKILL.md`; Grok writes
`.grok/skills/<name>/SKILL.md`. Agents accept the same restricted Markdown source
shape as Claude and use their respective `agents/<name>.md` directories. Kimi
rejects `agent`, `coder`, `explore`, `plan`; Grok rejects `general-purpose`,
`explore`, `plan`, to prevent unintended built-in replacement. No roles are
invented when the package declares `agents: null`.

Canonical MCP JSON is translated to named fields in `.kimi-code/mcp.json`
(`/mcpServers/<name>`) and `.grok/config.toml` (`/mcp_servers/<name>`). Canonical
`type` is omitted from these native entries. Only those entries are owned:
whole-file replacement and unrelated configuration fields are refused. Existing
foreign entries are conflicts or preserved, never silently adopted.

Both use the common AGENTS.md provider route. No Kimi SYSTEM.md, Grok system
prompt override, authentication, trust or model settings are generated.

### Discovery and launch limitations

Kimi and Grok can discover generic `.agents` skills. Removing one provider's
owned routes therefore does not prove that harness can no longer discover a
pipeline still installed for another provider. Installer ownership isolation and
native discovery are distinct checks.

Grok's child-environment helper sets five Claude compatibility switches to false:
skills, rules, agents, MCP and hooks. It changes only the child environment,
including removal of conflicting Windows key spellings. It does not switch
accounts, rewrite global configuration, grant trust or suppress native plugins.
The development CLI exposes a guarded [launch command](launch.md). Ordinary direct `grok` launch is
not certified by component rendering; local TOML presence is insufficient proof
of effective compatibility settings. Diagnostic plugin inventory can retain a
plugin even when its imported skill is disabled.

In the tested Grok 1.0.40 session, root CLAUDE.md was still read with all five
flags false. The common entry deliberately accommodates this behavior. It does
not prove suppression of duplicate agents, hooks or plugin MCP. Those runtime
checks remain separate; shared instructions do not imply full Claude compatibility.

Source and native inspect probes support development decisions; session-visible
discovery, trust behavior and execution remain separately tested requirements.
References: [Kimi skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html),
[Kimi agents](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html),
[Grok agents](https://docs.x.ai/build/features/subagents),
[Grok MCP](https://docs.x.ai/build/features/mcp-servers).
