# Read-only installation inspection (S6 development)

The internal `inspectInstallation(workspace, {recoveryPath}?)` API is implemented.
The public CLI exposes it read-only:

`workspace-pipeline doctor --workspace <absolute-path> [--recovery <relative-record>] [--json]`

Output is JSON even without --json. Exit 0 means configuration ready, 1 not ready
or incomplete, 2 invalid invocation or output failure. This is not an install command.

`ready` means observed **configuration readiness**, never a running harness,
Unity/MCP connectivity, task approval, permission to update, or deletion authority.
It does not write state: the on-disk historical status remains untouched.

Checks use local state and the installed snapshot; the original Git source,
workspace manifest and preparation directory need not still exist. No network
lookup or new package execution occurs. Managed file hashes and JSON field values
are checked; foreign siblings are not owned. Output does not include config values.

The history inventory pairs journal/recovery directories by exact UUID, validates
record chains and reports unfinished, malformed and orphan entries. A completed
journal alone does not establish activation or valid backups. Doctor selects a
completed transaction through the state's activation binding, then runs recovery
validation. Legacy unanchored states use conservative desired-deployment matching;
all such matches must pass. Selection is never by timestamp. Historical validation
errors or incomplete history force transactionEvidence=fail even if the selected
current transaction itself validates. An explicit path cannot hide invalid history.

For completed transactions bound to the exact current deployment, doctor compares
field-owned JSON by owned values rather than claiming ownership of foreign
siblings or formatting. Both the historical desired bytes and current bytes must
contain every owned value with its recorded hash. File-owned targets, malformed
JSON and changed/missing owned values do not qualify. Projected paths are explicit
in `fieldProjections`, bound to the exact recovery record. Historical receipts,
hashes and current observed byte hashes are not rewritten.

Ordinary `inspectRecovery` remains exact-byte validation. Doctor explicitly opts
into `fieldOwnershipOnly`; its result declares `comparisonScope` and may report
`desired-owned-fields` instead of byte equality. This exception is never available
to pending/incomplete journals and does not grant continuation or cleanup authority.

Completed continuation evidence may resolve an exact older unfinished entry.
History retains the original status and hashes and adds `resolution: continued`
plus exact `resolvedBy` recovery paths. A missing/corrupt approval, journal, source
snapshot, backup or lineage prevents this resolution. Only the corresponding
`history.unfinished` diagnostic is removed; unrelated problems stay visible.

The `evidenceOnly` recovery inspection used here reports `completed-evidence`,
not `applied`: activation and current targets remain `not-verified`. This makes
historical linkage survive a later legitimate update without pretending old
bytes are still current. Doctor separately validates the active transaction and
current owned configuration. Resolved history remains protected from cleanup;
an old unfinished journal is never rewritten as completed.

For repeated interruptions, `resolvesChain` lists the exact validated ancestors;
each ancestor keeps its own original status and hash. Validation is iterative,
cycle-checked and capped at 32 continuation links. Invalid/missing earlier evidence
prevents descendant resolution. All chain members remain cleanup-protected.

State, targets and history are observed again to detect drift. A present lock,
unknown or unfinished history, corrupt snapshot, mismatched workspace, invalid
recovery or target drift prevents readiness. Runtime is always `not-run`.
Historical transactions are not compared against today's target bytes as though
each were the current installation.

## Limits

S7 repository operations have separate pending markers and bootstrap/recovery
locks. Doctor reports their presence as `repository.pending`,
`repository.bootstrap-pending`, `repository.recovery-pending`, or
`repository.recovery-resume-pending`, with readiness
false, without clearing or interpreting malformed records as success. This is a
blocking observation, not full repository recovery verification.

Ordinary mutating commands cannot acquire/use a workspace lock while these markers
exist. Only the internal repository executor holding the real same-workspace
bootstrap capability may proceed with its own operation. Lifecycle CLI previews
also stop before source access. Read-only history listing remains available;
this does not imply that the new S7 namespaces are already covered by retention.

A recorded `not-installed` state with history requires matching completed removal
evidence. An activation binding selects the exact committed operation; all retained
completed history is still validated as historical evidence. Current removal
results, history, state and lock status are verified.
Successful absence is `status: not-installed`, `configuration: not-installed`,
`ready: false`; it does not claim an installed or runnable pipeline. Missing,
corrupt or unfinished evidence remains a reconciliation blocker. Original history
is not deleted or changed by this check.

New final states contain `activation` with relative recovery path, recovery hash
and completed journal sequence/hash. The reference is saved in the same checked
state write. Pending retains the prior reference. Doctor verifies that binding and
historical predecessor references; selecting a different recovery is an error.
Historical target bytes are not compared to today's configuration, but corrupt or
unfinished evidence remains a blocker. Predecessor cycles are rejected.

Old states without activation remain readable and conservative: all content-matching
records are checked against current results. No reference is synthesized on read.
The optional schemaVersion=1 field is backward-readable by the new CLI; older
strict readers reject extended states rather than ignoring an unknown field.
This is installation metadata, not a pipeline/document version requirement.

- Read-only observations are not an atomic filesystem snapshot; hostile same-user
  races are outside the guarantee. Run with configuration writers stopped.
- History enumeration is bounded to 1000 entries per journal/transaction parent.
  Exceeding the bound produces `history.limit`, not a partial healthy result.
- All inventory entries remain protected from cleanup. Retention/dependency
  eligibility and cleanup commands are separate S6 work.
- Errors remain visible; doctor never repairs config, deletes evidence, clears
  locks, renews approvals or silently selects an updated pipeline version.
- A missing state is `not-installed` only when metadata is absent; residual
  metadata with no valid state remains incomplete, not a clean installation.
- Provider-specific discovery/global compatibility checks are later adapter work;
  synthetic provider-double readiness is not live-provider certification.

### Repository completion is not lock recovery

The internal S7 completion verifier can confirm the exact approved repository
result after its pending marker has moved into history. That result does not mean
the workspace is unlocked or a pipeline is installed. If the process exited
abruptly, both its sibling bootstrap lock and `.pipeline/lock` may remain.
Read-only confirmation preserves them; ordinary operations remain blocked.
Do not delete those directories to bypass recovery. The public stale-lock recovery
route is not implemented yet. Tests distinguish an exception (which runs cleanup)
from a child process exiting without running `finally`.

Internal `recoverRepositoryLocks` now supports the paired stopped-owner locks
around finalization, with explicit approval of the exact lock-reconciliation digest.
It preserves both original lock directories under
`.pipeline/repository-lock-recoveries/<digest>/`, together with the request and
completion receipt. It does not replay repository effects or install a pipeline.
If finalization was pending, that separate operation remains necessary. Any failure
after recovery starts retains its sibling recovery gate; supported continuation
is described below. This is not a public CLI command.

Internal `inspectRepositoryLockRecovery` reconstructs interruptions after the
recovery request is persisted: before any rename, after the workspace-lock rename,
after both renames, and after receipt creation with the gate retained. It requires
the original lock digest plus repository preview/reconciliation bindings and
rechecks the repository result. Duplicate/missing lock locations, corrupted
records and changed results are refused. This read-only report never authorizes
resume or gate removal, including when a receipt is present. Interruptions before
the request is persisted remain outside this route.

Internal `finishRepositoryLockRecovery` supports all four recorded interruption
states listed above. The recovery owner must be a stopped local process and
the exact fresh observation must be explicitly approved. A sibling
`.recovery-resume` guard excludes competing resumptions and ordinary operations.
Only still-original lock directories are moved, in workspace/bootstrap order.
A missing receipt is created once; an existing receipt is preserved. Subjects,
owners, expected locations and records are rechecked between steps. The old gate
is moved into the recovery archive, then the resumption guard and approval are
also retained there. No repository effect is repeated. If this
resumption is interrupted, its guard remains blocking; recursive recovery of that
new interruption and failures before request persistence are not implemented yet.

Internal `inspectRepositoryLockResumption` can read an interrupted or completed
resumption without changing it. Supply the original lock digest and the exact
approved recovery observation digest, together with the repository subjects.
It distinguishes an active resumption, an archived old gate with a resumption
still pending, and a fully archived resumption. It checks the approval/owner
bindings and current repository result; duplicate locations and corrupt records
are refused. A completed record is not permission to replay the operation.
This check is for the same original subject before subsequent lifecycle changes;
it does not project stale evidence over later finalization or repository edits.
