# Removal preview and apply

The public CLI prepares removal without executing it:

```text
workspace-pipeline remove --workspace <absolute-wrapper> [--providers codex] [--bundles claude-grok]
workspace-pipeline remove --workspace <absolute-wrapper> --apply --preview <absolute-json-file>
```

Use installed bundle IDs, not necessarily the example `claude-grok`. Save the
preview privately, inspect it, then apply that exact preview without selectors.
Omit both selectors to remove all installed providers and bundles. Explicit
selection must be nonempty, unique and installed. A bundle member cannot be
selected independently: `remove.bundle-required` requires selecting its bundle.
The internal API is `prepareRemoval(workspace, registry, {providers, bundles})`.
See [bundle delivery](provider-bundles.md) and [CLI lifecycle](lifecycle-cli.md).

Shared AGENTS.md stays while any provider remains; shared CLAUDE.md stays while
Claude or Grok remains. Full removal has desired=null;
partial removal retains source/version/layout and the remaining ownership.

The installed snapshot is replayed through trusted adapters. Every managed value
must still match; missing or user-edited owned values block the whole preview.
No original Git lookup or latest-version selection occurs.

- Created owned files are proposed for deletion, never directories/repositories.
- Taken-over files are restored to exact original backup bytes.
- JSON fields are removed or restored individually; current foreign siblings stay.
- JSON containers are kept, even if empty. No guessed directory/file cleanup.
- Historical backup files and evidence are retained, not removal targets.

State, managed observations, snapshot replay and used backups are rechecked.
The envelope contains private before/output bytes and may contain secrets. Do not
publish it as a diagnostic. applySupported=true refers only to the internal
executor; fresh approval of the saved preview is required for public CLI apply.
`verifyRemovalApproval(lock, prepared, approval, registry)` requires a fresh exact
digest approval and a live lock, then reconstructs the whole preview from installed
state. Changed targets, foreign siblings, retained-provider files, backups or
prepared payload invalidate the preview. This is read-only preflight, not execution.

## Internal execution

`applyRemoval(lock, prepared, approval, registry)` repeats installed replay under
the live lock. It preserves and verifies all original backup files, including
those belonging to retained providers. Exact file unlink is allowed only for
created managed files whose bytes still match immediately before deletion.
Directories, repositories, history and backups are never deleted. Portable Node
APIs cannot exclude hostile same-user races after the last filesystem check.

A new journal and recovery record precede pending state and target writes. Full
removal ends in `not-installed`, partial removal in `ready` with remaining/shared
ownership. `inspectRecovery` checks either result and interrupted deletion without
clearing pending state or inventing missing readbacks. Failures after unlink stay
uncertain even when the file is absent. Original journal outcomes are retained.

Internal continuation retains command remove and original backup/snapshot lineage.
An already absent target becomes `verify-absent` (both hashes null, no payload or
fields): a fresh readback, never a repeated unlink. Untouched files retain delete
or restore work. A new exact approval and journal are required; original outcomes
are preserved. Repeated interruptions use the bounded existing lineage mechanism.
`verify-absent` is a validated continuation readback, not general target-deletion
authority. It is also supported for the narrowly scoped retirement of an owned
member file when updating a still-selected bundle; see [bundle delivery](provider-bundles.md).

Doctor recognizes a
completed removal with retained history only after validating matching removal
evidence and current results; it reports not-installed, never ready. Public switch
routing is described in [CLI lifecycle](lifecycle-cli.md). These operations do
not certify live-provider behavior. An operational
version tag never requires document reapproval.
