# Lifecycle CLI routing — development scope

This page describes schema-1 legacy operations and their saved-plan/recovery
contract. For the new schema-2 desired-state setup/update (no mandatory preview,
no default backup), see [the desired-state guide](desired-state.md). Do not apply
the legacy conflict/backup/launcher rules below to the new installer.

The generic dispatcher routes `setup`, `update`, `repair`, `remove`, `switch` and `continue` through
the native operation APIs and their coordinators. The packaged entrypoint supplies
compiled Codex, Claude, Kimi and Grok adapters. S11 review and native Kimi/Grok
verification remain open; use disposable workspaces for these additions.
For Grok Claude-import suppression use the [scoped launcher](launch.md), not a
direct harness invocation. File readiness does not certify runtime isolation.

Tests supply a trusted registry directly to `runCli`. There is no argv flag,
environment-selected module, or pipeline-supplied executable adapter loader.
Direct library calls without a registry still fail with `cli.providers-unavailable`.
CLI assembly supplies built-in adapters, never package code.

## Preview and apply contract

### Everyday update (executable)

`workspace-pipeline update --workspace <absolute-wrapper>` prepares a plan,
shows every affected path and any user-wide Grok compatibility changes, and
asks `Apply these changes? [y/N]`. Accepted confirmations are `y`, `yes`, `д`,
or `да` (case-insensitive, surrounding whitespace ignored). Enter or any other
answer cancels. Cancellation exits 0 with `status: cancelled, applied: false`;
exit 0 alone does not mean an update was applied. The CLI
manages a private temporary preview internally and uses the same approval and
drift checks as saved-plan apply. No automatic reset or conflict bypass occurs.

`--yes` authorizes this update without a prompt (including displayed global
changes). Non-interactive input without `--yes` refuses before preparation.
`--preview` explicitly requests preparation only. `--preview --json` saves a
machine plan; for compatibility, `update --json` alone also remains preview-only.
`--yes --json` emits the final machine result on stdout and the change summary
on stderr; `--json` by itself never authorizes writes. The deterministic embedded
`runCli` API keeps its prior preview/apply behavior; this convenience is in the
executable entry layer. Other commands keep their existing explicit flow.

```
workspace-pipeline update --workspace C:\Work\Game
workspace-pipeline update --workspace C:\Work\Game --yes
workspace-pipeline update --workspace C:\Work\Game --preview --json > preview.json
workspace-pipeline update --workspace C:\Work\Game --apply --preview C:\Private\preview.json
```

Saved plans remain useful for LLM work, migrations and separate approval. Do not
share them publicly: configuration payloads can contain private values. A failed
apply can have partial effects: inspect doctor/recovery, do not blindly retry.

The internal preview is in the current user's OS temporary directory, inside a
unique `wpc-approved-update-*` directory. It may contain private configuration.
On POSIX the preview is created with mode `0600`; Windows/NTFS does not enforce
that POSIX mode, so confidentiality depends on the inherited Windows ACLs of
your temporary directory. The CLI does not change those ACLs. Use a private
user temp directory, not a shared writable temp location.

Normal completion (including handled apply failure) attempts to remove only
that preview and its empty directory. A killed process or failed cleanup can
leave the directory behind; there is no automatic janitor. After stopping the
owning update process and inspecting doctor/recovery, you may manually remove
its obsolete `wpc-approved-update-*` directory. Do not delete another active
run's directory or `.pipeline/transactions`/backups as part of this cleanup.
The temporary preview is not a replacement for durable recovery evidence.

Once a trusted registry is provided by the CLI assembly:

```text
workspace-pipeline setup --workspace <absolute-wrapper> [--manifest <absolute-file>]
workspace-pipeline update --workspace <absolute-wrapper> [--manifest <absolute-file>]
workspace-pipeline setup --workspace <absolute-wrapper> --apply --preview <absolute-json-file>
workspace-pipeline update --workspace <absolute-wrapper> --apply --preview <absolute-json-file>
```

Preview displays a human-readable summary by default. Add `--json` to return
the complete prepared JSON on stdout for saving and subsequent apply. It may acquire a Git
source into temporary storage outside the wrapper, but does not write provider
configuration. Remote Git acquisition follows the selected source. When manifest
is omitted, setup uses the standard workspace manifest; update uses the recorded
manifest origin. Relocation does not silently rebind it. Use the explicit
[manifest rebind workflow](rebind.md) to change that origin.

Save prepared JSON privately, inspect its operations and then explicitly invoke
`--apply --preview`. It may contain configuration secrets and absolute local
paths; do not commit it or send it to shared logs. Apply does not accept
`--manifest`, acquire a fresh source, or substitute a new preview.
Missing/stale staged data is an error, not permission to download replacements.

Apply binds the verb and exact wrapper before lock acquisition, then invokes
existing locked approval, registry, ownership, history, snapshot and drift checks.
`--apply` authorizes only that saved prepared subject; no approval is inferred
from preview generation. Existing local opt-in retention is handled by the
internal lifecycle coordinator, not a second cleanup pass in the dispatcher.

### Renamed or removed skills during update

For a provider that remains selected, update retires an old managed
`skills/<name>/SKILL.md` when the new source no longer supplies that path.
The exact deletion appears in the preview; if installation took over an existing
file, update restores its verified original backup instead. This supports names
such as `unity-review` changing to `sdx-review` without leaving duplicate skills.

Only recorded, unchanged native skill entry files qualify. A user edit before
preview or after approval blocks the operation. User-added files (including notes
beside a retired skill), other skills, agent definitions, configuration files and
root instructions are not cleaned up by this rule. Directories are not recursively
deleted. Provider/bundle removal remains a separate selection operation, except
for the existing bundle-member update behavior.

This is not a reset or a force-update option. Missing owned files should be
repaired from the installed snapshot first; conflicting local customizations
must not be silently discarded. Rebind only approves a new manifest origin;
it does not relax these ownership checks.

To deliberately discard local adapter customizations, use the separate
[reset preview/backup/apply workflow](reset.md). Its default is installed-snapshot
restoration; empty reset must be explicitly selected.

## Output and failures

- stdout: readable result by default; with `--json`, one complete prepared JSON or operation result.
- stderr during apply: structured journal/recovery locations and operation events.
- exit 0: preview created, or observed configuration ready with successful lock
  release and reporting. It never certifies harness/MCP runtime.
- exit 1: lifecycle failure/incomplete result, including a wrong verb or wrapper
  in the prepared package. Read the operation result, not just the exit code.
- exit 2: invalid invocation, unavailable adapters, input/transport failure.

If stdout fails after a successful apply, exit 2 does not undo that apply.
Operation events and `doctor` distinguish actual configuration state from output
delivery. Errors expose stable codes, not raw exception messages or argv secrets.
The workspace transaction does not force unlock, rollback or mutate global config.
For Claude-only delivery, the public CLI binds a separate, explicit
[user-wide Grok prerequisite](claude-grok.md) to preview/apply. Workspace success
followed by prerequisite failure is reported as `needs-compatibility`.

## Offline repair and removal

These routes have the same trusted-registry restriction as setup/update:

```text
workspace-pipeline repair --workspace <absolute-wrapper>
workspace-pipeline remove --workspace <absolute-wrapper> [--providers codex] [--bundles claude-grok]
workspace-pipeline repair --workspace <absolute-wrapper> --apply --preview <absolute-json-file>
workspace-pipeline remove --workspace <absolute-wrapper> --apply --preview <absolute-json-file>
```

Repair reconstructs only the approved installed snapshot, not the newest source.
Removal preserves other installed providers and shared files while needed; full
removal restores taken-over content and removes only owned scope. Missing/corrupt
snapshots, backups, unresolved history or conflicting user edits fail closed.
Neither route reads the original manifest or downloads from Git. `--manifest`
is rejected. `--providers` and `--bundles` are remove-preview-only;
omitting both previews all installed providers and bundles. Use actual installed
bundle IDs; selecting a bundle member via `--providers` fails with
`remove.bundle-required`. The saved subject fixes the actual selection, so apply
cannot override it. See [removal](remove.md) and [bundle delivery](provider-bundles.md).

The maintenance coordinator validates exact command/workspace and record before
locking, checks history under lock and calls native approval/replay. It reports
journal/recovery locations early and preserves partial evidence on failure.
Successful full removal returns `not-installed` with exit 0, not `ready`; runtime
is still unverified. A failed output delivery cannot roll back successful work.

Automatic retention remains setup/update-only at this stage; maintenance does
not silently clean history or use removal approval as cleanup permission.
Interrupted-operation continuation has a separate exact approval boundary below.

## Switching pipeline

With the same trusted built-in registry restriction:

```text
workspace-pipeline switch --workspace <absolute-wrapper> --manifest <absolute-incoming-manifest>
workspace-pipeline switch --workspace <absolute-wrapper> --apply --preview <absolute-json-file>
```

The incoming manifest is mandatory for preview. Preparation stages and validates
the incoming Git package before removal; it does not change workspace files.
Apply accepts only the saved prepared subject, not manifest/network overrides.
Under the workspace lock it persists recovery, marks the operation pending,
executes `remove-old` then `install-new`, and activates only after both phases
and final targets are checked. Completed phases alone do not mean activation.

Events identify journal/recovery locations and phase progress. An interruption
between phases leaves the actual state `needs-reconciliation` and the old active
identity; an operation result of `failed` does not imply unchanged files.
Re-running switch is not an implicit retry or recovery command. There is no
automatic rollback, source reacquisition, or retention cleanup in this route.
Use read-only doctor/history to inspect retained state. Continuation eligibility
is narrower than arbitrary failure recovery, as described below.

## Continuing an interrupted operation

```text
workspace-pipeline continue --workspace <absolute-wrapper> --recovery .pipeline/transactions/<run-id>/recovery.json
workspace-pipeline continue --workspace <absolute-wrapper> --apply --preview <absolute-json-file>
```

The registry restriction still applies. Select an exact workspace-relative recovery
record, never the newest filename or timestamp. Preview is read-only and private;
it may contain desired configuration bytes. Apply accepts no recovery/source/network
override and reconstructs the saved proposal under lock before any target writes.

This creates a new journal and recovery record. Old records are preserved; desired
bytes are read back, not written again, and before bytes require the new approval.
Conflicting bytes, stale pending state, corrupt ancestry or changed evidence reject
continuation. Removal may end in not-installed; success is not runtime certification.
Reporter failures retain evidence and never trigger rollback or automatic retry.

The native eligibility rules remain authoritative: general operations require a
valid pending record without conflicts. Switch accepts an uncertain target or a
verified open/completed journal still selected by pending state. At a clean
boundary, `uncertain: null` means no ambiguous write: only unrecorded operations
and phase checks remain. Completed outcomes are not replayed. After both recorded
phase checks, an empty remainder permits separately checked activation, not an
inferred phase success. Failed/corrupt journals and changed targets fail closed.
No source download, force unlock or retention cleanup occurs. A Claude-only
continuation with an explicit compatibility envelope can apply its separately
approved global prerequisite. Historical switch continuations only inspect it
after activation; missing compatibility requires a fresh repair preview/apply.
