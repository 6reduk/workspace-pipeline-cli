# Repository recovery — development checkpoint

Repository recovery does not install providers or automatically replay/undo effects.
Use `finalize` for verified completed operations, `recover-locks` for native-verified
stopped-owner retirement, and `abandon` for an explicit decision to preserve the
observed partial state without claiming completion. See the sections below and
[manual decision boundaries](repository-manual-recovery.md) for unbound/torn inputs.
Author checks and independent S7 acceptance remain separate.

Run from any directory, naming the wrapper explicitly:

```powershell
workspace-pipeline repositories status --workspace "C:\Work\MyWorkspace"
workspace-pipeline repositories finalize --workspace "C:\Work\MyWorkspace"
```

Both commands are read-only and print JSON. Save the complete finalize JSON to a
private UTF-8 file, inspect its operation and blockers, then explicitly apply:

```powershell
workspace-pipeline repositories finalize --workspace "C:\Work\MyWorkspace" --apply --preview "C:\Private\finalize-preview.json"
```

The preview must still match the workspace, retained inputs, evidence and observed
repository contents. Apply does not refresh an outdated preview or fetch source.
If a previous attempt already wrote the exact completion receipt but did not move
the pending marker, the preview selects receipt resumption. No repository effect
is repeated. Missing/damaged historical inputs or conflicting evidence are errors,
not permission to guess. Old installations without retained inputs are not silently
migrated by these commands.

New operations save execution inputs under `.pipeline/repository-inputs/`, before
repository effects. Keep this directory private and do not remove its files while
an operation is unresolved. `logs list` shows the locations. S7 history is currently
protected when pending or referenced; `logs clean --repositories` can select only
native-verified unreferenced completed groups with explicit age/count/run limits.
Ordinary `logs clean` keeps its existing separate scope. Do not manually
delete pending markers or lock directories to make `doctor` report success.

`no-pending-marker` means exactly that; it does not certify historical completion,
provider readiness or game runtime. A blocker means further recovery is needed;
this command never grants itself authority to resolve it. `--json` is redundant
but accepted because JSON is already the default output.

## Local recovery ownership

Recovery writers use an ephemeral local IPC lease: a Windows named pipe, or a
Linux abstract socket. This is not TCP and does not expose a data protocol. Process
exit releases the kernel-owned endpoint; progress remains in existing durable
records. Different recoverers cannot simply adopt a dead owner's directory.
Persistent pending guards continue to protect ordinary lifecycle writers.

The current implementation supports this primitive on Windows/Linux only; other
platforms fail explicitly. Windows synthetic tests exist; Linux runtime validation
is still pending. It is not a distributed lock for shared/network filesystems and
does not isolate arbitrary editors or hostile processes running as the same user.
See [Node IPC documentation](https://nodejs.org/api/net.html#ipc-support).

Never interpret an old approval or a stopped PID alone as permission to continue.
Repeated continuation requires a new exact observed-state approval. Remaining
bootstrap and partial-effect routes are described below. The Windows ownership checkpoint
was independently reviewed; this is not full S7 acceptance.

Existing wrapper roots and ancestors must not be links/junctions/reparse aliases;
they are rejected, not assigned a second lease identity. Persistent record names
retain their existing spelling; this change does not rename historical records.

`recovery-lease.busy-or-access-denied` means the OS returned EACCES: contention
and a permission problem cannot be distinguished safely here. No lock is stolen.
Errors ending in `status-required` identify lease loss or release-phase failure,
possibly after durable effects completed. Inspect status and retained records before
retrying; the error does not mean rollback occurred. A simultaneous callback and
release failure is reported separately, without leaking raw OS error text.

## Stopped-owner lock recovery

For an evidenced, completed repository operation whose locks were retained by a
stopped process, select the exact journal UUID from its pending/completion record
or `logs list`. Do not choose an operation by timestamp or assume the newest UUID.

```text
workspace-pipeline repositories recover-locks --workspace <absolute-wrapper> --journal <journal-uuid>
workspace-pipeline repositories recover-locks --workspace <absolute-wrapper> --journal <journal-uuid> --apply --preview <absolute-preview.json>
```

The first command is read-only. Save its complete JSON privately in UTF-8 and
inspect it before the second command. The preview identifies initial retirement,
interrupted retirement or repeated continuation, binds retained inputs and exact
observed state, and blocks live/unknown owners. Apply rechecks under native kernel
ownership. Original locks/owner records are retained, not recursively deleted.
The command neither replays repository effects nor configures providers. A pending
finalization remains a separate `repositories finalize` action after locks retire.

Repeated continuation now writes `continuation-NNNNNN.json` inside the existing
resumption directory **before** remaining recovery actions. These are immutable
authorization records, not additional locks. Each binds the fresh observation and
the hashes of preceding records. Completion retains the directory under the original
lock-recovery archive; `logs list` reports that protected archive. An already-complete
native continuation is read-only and does not append another approval. Active chains
are bounded to 128 records / 32 MiB and individual records to the normal input cap;
limit errors stop before another append, without deleting history.

This route is deliberately limited to evidenced completed repository effects.
Incomplete bootstrap creation, missing old retained inputs, uncertain effects and
partial authorization-file writes still require separate handling. An error never
authorizes blind lock removal or replay. S7 retention and those recovery routes
are not declared complete.

## Interrupted bootstrap recovery

New bootstrap recovery attempts preserve the complete original request beside the
recovery owner, before relocating the original lock. If that recovery process dies,
the following command reconstructs the remaining actions without source acquisition:

```text
workspace-pipeline repositories continue-bootstrap --workspace <absolute-wrapper>
workspace-pipeline repositories continue-bootstrap --workspace <absolute-wrapper> --apply --preview <absolute-preview.json>
```

Save and inspect the first command's JSON privately in UTF-8. The second command
rechecks that exact preview under exclusive recovery ownership. Only a stopped,
local owner is eligible. Continuation does not recreate the wrapper or replay a
repository operation. It may finish moving the original intent/lock, persist the
exact recovery receipt, and archive the recovery gate. It preserves foreign data
and refuses inconsistent, missing, duplicated or damaged evidence.

The original request and subsequent approvals are retained in the sibling directory
`.wpc-bootstrap-recovery-<initial-reconciliation-hash>`. `logs list` shows its path
as protected recovery evidence, outside completed-transaction cleanup. To inspect completed
history, add `--initial sha256:<initial-reconciliation-hash>` explicitly. Completed
verification performs no write; subsequent legitimate wrapper changes may invalidate
the old completion observation and are not silently ignored.

The active guard admits at most 64 continuation approvals and a bounded 16 MiB
inventory; each input is still subject to the normal per-record size cap. Reaching
a limit does not authorize deleting active history. A crash before the original
request is fully published, legacy owner-only guards, torn approvals, or wrapper
creation without a consistent receipt are still unsupported recovery cases. They
remain fail-closed, not guessed or auto-replayed. See the manual decision boundary.

## Explicit abandonment of an unfinished repository operation

`repositories abandon --workspace <absolute-wrapper>` produces a private exact
preview for **preserve current state, abandon the old request**. Save and inspect
the preview, then use the same command with `--apply --preview <file>`. It records
target/source trees, all retained metadata, marker/input hashes and stopped lock
owners. A changed tree requires a new preview. Missing/torn owner information or
unknown/live owners cannot be approved through this command.

The operation does not retry clone/init/move, delete repository data, restore the
old state, or claim completion. It archives the pending marker and any known stopped
locks in `.wpc-repository-resolution-<uuid>` beside the wrapper. The archive retains
the exact decision and a receipt with `completed:false`. An ephemeral recovery lease
and durable recovery gate protect the remaining moves. A new init/adopt preview is
required afterwards; choose `keep` for retained usable repositories or separately
resolve unwanted partial data. A partial clone is not converted into a verified clone.

After interruption, run `repositories continue-abandon --workspace <wrapper>
--attempt <uuid>` for a fresh preview, then add `--apply --preview <file>`. The old
request and subsequent approvals remain immutable. Completed-history verification
is not a certification of later changes to the repository. If publication stopped
before a complete guard/request exists, consult the manual decision boundary; no
automatic deletion or request reconstruction is attempted.

## Shared execution and its ownership boundary

Initial recovery and continuation share the same remaining-action engine within
each domain (bootstrap archival and paired repository-lock retirement). Approval
and ownership acquisition remain distinct: the initial call verifies its own live
gate owner; continuation requires the prior recorded owner to have stopped and
retains fresh approval. Both use the kernel lease and recheck evidence between
effects. A shared engine does not authorize replay of uncertain effects or repair
of incomplete records. Paired retirement rechecks the repository subject before
moving the second lock, not only after both moves.

## Stopped owner before the bootstrap request

One early state has a deliberately narrow archival route: the wrapper is absent,
the bootstrap lock contains only a valid `owner.json`, and its local process is
confirmed stopped. No operation request or intent may be present.

```text
workspace-pipeline repositories retire-bootstrap --workspace <absolute-wrapper>
workspace-pipeline repositories retire-bootstrap --workspace <absolute-wrapper> --apply --preview <absolute-preview.json>
```

Save/inspect the first command's private UTF-8 JSON before apply. It names the exact
history destination `.wpc-bootstrap-abandoned-<attempt-uuid>` next to the wrapper.
Apply retains that preview before moving the entire old lock into `history/lock`.
The original lock blocks ordinary creators until the single final rename; the
existing kernel lease excludes competing recovery writers. No extra recovery lock,
repository replay, wrapper creation, deletion or claim of historical success occurs.

If interrupted before that rename, the old lock still blocks writers. Inspect a
**new preview** to attempt archival again; it chooses a new history location and
does not overwrite the earlier incomplete history. After the rename, only the
selected original lock's preserved history can be verified. This does not certify
the current wrapper state: another legitimate creator may already have started.

`logs list` reports attributable history as protected; unreadable/empty abandoned
history appears as a diagnostic with its location. Do not delete active records to
clear a blocker. These records remain protected recovery evidence. Empty, torn, foreign,
live or unknown owner records, recovery gates, existing wrappers and any intent or
extra lock files are outside this route and remain blocked.
