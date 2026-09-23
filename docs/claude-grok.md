# One Claude delivery for Claude Code and Grok

Select a Claude-only source bundle, such as the new Unity `claude-grok` bundle.
The name describes its consumers; its provider list contains only `claude`.
The source supplies one full `CLAUDE.md`, `.claude/skills`, optional
`.claude/agents`, and `.mcp.json`. Start either `claude` or plain `grok` in the
wrapper. Do not use the old `launch grok` command: it is only for legacy native
Grok deliveries and disables the imports this mode needs.

## What setup changes

Normal setup/update/repair/reset preview now includes a **separate user-wide
Grok prerequisite** when the desired delivery includes Claude but not native
Grok. If Grok is absent, it is reported as `not-present`; Claude still installs.
Old dual-provider sources retain their legacy behavior until migrated.

If Grok exists, explicit apply enables only these settings in its effective user
profile (`GROK_HOME/config.toml`, otherwise the user's `.grok/config.toml`):

```toml
[compat.claude]
skills = true
rules = true
agents = true
mcps = true
hooks = true
```

These preferences affect **all Grok workspaces**, including user-installed
hooks/MCP. They are not workspace isolation. Other settings, including model,
credentials, trust, permission rules and `compat.claude.sessions`, are preserved.
The installer never grants folder trust or starts a model/MCP session.

Use the normal command with `--json` to save its complete preview, then review
and apply that exact file. New Claude-only previews bind both the workspace
plan and the global prerequisite. Old previews must be regenerated; do not
manually unwrap/edit a preview to avoid its global checks.
This includes old ordinary (non-switch) continuation previews: regenerate with
`continue --workspace <path> --recovery <retained-record>` and approve the new
preview. Existing recovery evidence remains unchanged; it is not a lockout.

Close configuration editors while applying. Backups and operation records live
under `<GROK_HOME>/workspace-pipeline-backups/<id>/`, **not in the workspace**.
The reported directory contains `config.before.toml` when a file existed,
`operation.json`, and on success `completed.json`. Backups may contain secrets;
keep them private. They are not covered by workspace journal cleanup. Review
and remove obsolete backup directories manually when no longer needed.

## Diagnosis and repair

`doctor` checks actual configuration and known overriding environment/policy
conditions. When a native Grok executable is available it also runs bounded
`grok inspect --json` without `--trust`, retaining only compatibility results.
It reports native inspection separately. This does not prove model-visible
skills, execution of agents, a working MCP connection or task acceptance.
Untrusted workspace discovery may be incomplete; grant trust yourself in the
harness only after reviewing the workspace.

Conflicting environment overrides, managed policy files, legacy import markers,
malformed/unsupported TOML, symlinks and stale before hashes fail closed. The CLI
does not override organization policy or silently remove an import marker.
An existing policy file conservatively requires separate resolution, even if
it might not ultimately pin these five fields. A missing native binary yields
`native: not-available`, not an invented native PASS.

If the workspace operation succeeded but global configuration failed, the
result is `needs-compatibility`, with `workspaceStatus: ready`. Workspace files
are already installed; run a fresh **repair preview/apply**, rather than replaying
a stale setup preview. There is no claim of a cross-filesystem atomic transaction.
Historical switch continuations have no global approval envelope: after workspace
activation they inspect compatibility without changing it. If needed, finish with
a fresh repair preview/apply. Source authors must make their complete `CLAUDE.md`
usable by either harness, not require a nonexistent Grok provider route.

To inspect/enable the same prerequisite separately (for example after installing
Grok later), use:

```powershell
workspace-pipeline compat claude --json > compat-preview.json
workspace-pipeline compat claude --apply --preview "C:\absolute\compat-preview.json"
```

After a killed installer, a recorded dead-process lock can be recovered:

```powershell
workspace-pipeline compat claude recover-lock --json > lock-preview.json
workspace-pipeline compat claude recover-lock --apply --preview "C:\absolute\lock-preview.json"
```

Recovery verifies the saved lock, current config hash and that the owner PID is
not alive. It removes only that installer lock; it does not restore config or
delete evidence. Then inspect backups and run fresh repair. A malformed lock,
PID reuse, or a crash during lock recovery itself requires manual diagnosis;
the tool refuses to guess or automatically delete an unknown/live lock.

## Update and removal

When a still-selected bundle drops its old native Grok member, ordinary update
retires only owned Grok files/fields and preserves personal settings. Modified
owned files remain conflicts; review/reset them explicitly. Codex delivery is
not removed. Grok can also discover `.agents/skills`, so use matching canonical
pipeline skills and check actual source selection, not merely unique names.

Removing a workspace **leaves the user-wide compat preferences enabled**: other
workspaces may depend on them. Backups are not restored automatically. To undo
a preference, review the backup and current config and change only the relevant
fields; never overwrite a later personal config wholesale with an old backup.

## Contributor boundaries

`src/compat/claude.js` owns the bounded profile editor/backup/lock and sanitized
native inspection. `src/compat/lifecycle.js` binds the additional approval at
the public CLI boundary; workspace schemas, historical recovery bytes and path
ownership remain unchanged. Embedded `runCli` callers explicitly inject the
compatibility service; the real executable supplies it. Source packages cannot
provide executable adapter code or arbitrary global destinations.

Run `node --test test/claude-compat.test.js`, the full regression and
`npm run test:packed:claude-compat`. The packed test uses only temporary profiles
and exercises a dual-provider-to-Claude-only migration, drift, repair/reset and
removal. Neither a successful test nor this document claims publication or a
real-workspace migration.
