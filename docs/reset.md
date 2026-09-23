# Reset a local adapter environment

Use reset when you deliberately want to discard local pipeline customizations.
Ordinary `update`, `repair` and `remove` continue to protect conflicting edits.
Reset is an offline operation on the **installed snapshot**, not an upgrade.
It does not reset Git repositories or delete the workspace.

Availability: introduced in 0.3.0; not present in 0.2.0.

## Preview first

Close running harnesses/configuration editors. Keep preview files private: they
contain before/after bytes, potentially including MCP credentials.

```powershell
workspace-pipeline reset --workspace 'C:\Work\Game' --all --json > 'C:\Private\reset.json'
# Check $LASTEXITCODE and review reset.scope, reset.backup and preview.plan.targets.
workspace-pipeline reset --workspace 'C:\Work\Game' --apply --preview 'C:\Private\reset.json'
workspace-pipeline doctor --workspace 'C:\Work\Game'
```

The default is `--to installed`: clean the selected scope and restore its supplied
configuration from the installed snapshot. Use `--to empty` explicitly to remove
the selected adapter configuration instead. After full empty reset, `doctor`
reports `not-installed` (exit 1), not an installed/ready pipeline. Then use setup
with a chosen manifest. For an upgrade after customization, reset to installed,
then perform a normal update from the source you selected.

Selection is mandatory: `--all`, or `--providers codex`, or
`--bundles claude-grok` (use the actual installed bundle ID). Provider and bundle
lists can be combined, but not with `--all`. Claude/Grok bundle members cannot be
selected individually. Apply accepts only the saved preview, no mode/selection
overrides. Preview generation alone changes no provider files.

## Exactly what is reset

| Selected provider | File trees, including user additions | Configuration sections |
| --- | --- | --- |
| Codex | `.agents/skills`, `.codex/agents` | Named agents and MCP servers in `.codex/config.toml` |
| Claude | `.claude/skills`, `.claude/agents` | `mcpServers` in `.mcp.json` |
| Grok | `.grok/skills`, `.grok/agents` | `mcp_servers` in `.grok/config.toml` |
| Kimi | `.kimi-code/skills`, `.kimi-code/agents` | `mcpServers` in `.kimi-code/mcp.json` |

Only recorded `AGENTS.md` / `CLAUDE.md` entry files associated with the selection
are included. Shared entries remain when unselected providers need them. Conflicts
in unselected owned files block reset rather than being repaired implicitly.
Kimi configuration tests do not imply native Kimi runtime support is verified.

This is **not** recursive deletion of `.codex`, `.claude`, `.grok`, `.kimi-code`,
or the wrapper. Repositories, documents, assets, `.git`, manifests, snapshots,
history, globals, account/auth files, model/permission/trust settings and unrelated
configuration sections remain. Codex agent runtime/model controls also remain,
as do unknown non-table values under `[agents]` (scalars, dates and arrays).
Non-control table entries under `[agents]` are treated as named agent definitions.
Unknown files outside the listed trees are not guessed to be pipeline files.
Files under listed trees are included regardless of ignore rules. Empty directories
and empty containing configuration files may remain; they are not an active skill
or MCP declaration. Grok still uses its scoped launcher for import suppression.

Malformed configurations, unsupported TOML representations, unsafe paths/links,
hardlinks, repository overlap, unavailable snapshots, incompatible renderer replay,
broken history and pending operations cause a refusal. Reset is not a force option
for corrupted installer metadata. No Git download, harness or MCP is started.

The portable path policy currently rejects non-ASCII names inside scoped trees,
including Cyrillic user filenames. Reset refuses the whole operation rather than
skipping those files. Move such additions to a safe location outside the reset
trees or rename them yourself, then generate a new preview; do not reuse an old
approval after changing the file inventory.

## Backups and interruptions

Before target changes, the CLI saves and verifies complete original bytes at
`.pipeline/backups/reset/<digest>/`. It prints that location and the transaction's
journal/recovery paths. `manifest.json` maps each binary backup to its original
workspace-relative path and SHA-256. Backups can contain secrets: keep them local,
do not commit or publish them. Logs cleanup does not delete these backups.

If backup verification fails, no provider target is changed. A later failure can
leave partial effects; do not treat a failure as rollback. Inspect the reported
recovery and use the normal `continue` preview/apply workflow. It rechecks the
exact approved scope and preserves the original records and backups. Added or
changed files invalidate the applicable preview; they are never silently included
in a previous destructive approval. Stop other writers while applying.

To recover an individual discarded customization after successful reset, read
the backup manifest, verify the selected `.bin` hash, and copy only those bytes
to its listed destination after checking the current file and saving any newer
edits. This is a deliberate customization: doctor/update may then report drift.
Do not copy an old `.pipeline/state.json`, overwrite an entire provider directory,
or restore a whole config file without reviewing newer settings/credentials.
Reset does not provide automatic rollback of account settings or Git work.

Reset creates a new clean ownership baseline for its selected supplied entries;
ordinary removal will not resurrect discarded pre-reset custom configuration.
Historical backups remain available for explicit recovery.
