# Switch lifecycle (internal APIs and CLI)

Current implementation includes phase execution, repeated uncertain continuation,
final activation and doctor/history integration. CLI preview/apply routing is
available with the packaged Codex/Claude registry. This does not authorize a live
project migration. See [CLI contract](lifecycle-cli.md).
The CLI routes uncertain-target and clean-boundary continuation, including a
completed journal whose activation is still pending. See boundary rules below.
Older prerequisite sections describe their historical implementation boundaries;
the CLI contract and boundary section describe the current combined behavior.
Prerequisite sections describe their own limited scope, not execution authority.

`composeSwitchPreview({previous, removal, replacement})` is pure, non-executable
composition. `removal` is a full-removal native preview against actual previous
state. `replacement` is a setup candidate against the projected post-removal
configuration, not a setup request executed against an active workspace.

The function checks both envelopes, enforces the same workspace/layout, different
pipeline identity and snapshot digest, and binds incoming before bytes to removal
results wherever paths overlap. It retains separate remove-old/install-new phases,
initial observations and projected final results. Foreign observations survive.
No mutation of input, filesystem, Git, configs or approvals occurs.

The returned envelope has applySupported=false and sourceVerification=not-verified.
Pure schema/hash consistency is not proof of installed ownership, trusted adapter
replay or staged source bytes. The future coordinator must stage and validate the
new Git source before any removal and obtain fresh approval under a live lock.
Source manifests cannot inject executable adapters.

## Git-backed preparation (internal, no apply)

`prepareSwitch({wrapper, manifestPath, network?, tempRoot?}, registry)` in
`operations/switch-prepare.js` stages an explicitly selected Git source outside
the wrapper. It replays the installed package to prepare full removal, verifies
the incoming package, invokes trusted CLI adapters, and composes incoming requests
against projected post-removal bytes. Existing foreign files/JSON fields remain
subject to normal ownership checks; switch grants no takeover authority.

The old removal/state, incoming manifest, staged snapshot and observed destination
bytes are rechecked after adapter work. The outer private envelope reports
`sourceVerification: verified-at-preparation`, not ongoing source freshness; its
embedded pure phase preview deliberately retains `not-verified`. Preparation can
write disposable Git staging directories outside the workspace (also on failure),
but never applies removal, installs provider files, creates a journal, or modifies
workspace state. No temporary-directory deletion or cleanup policy is added here.

`applySupported` remains false. There is no lock, atomic snapshot, approval or
crash-recovery guarantee for this preview. A future executor must replay/approve
the exact two-phase operation under a live workspace lock and use one phased
journal. Public source switches remain unavailable.

Public switch routing remains unimplemented. Existing native
single-phase journals cannot simply concatenate targets when the same path is
deleted/restored and later recreated. The phased journal keeps those two
steps and their readbacks distinct under one operation, with non-ready state on
interruption. No remove-plus-unrelated-setup workaround is enabled.

## Two-phase event model

`inspectSwitchEvents(preview, previous, events)` verifies a single ordered chain
bound to the reconstructed two-phase preview. Events have exact keys, sequence,
previous canonical event digest and preview digest. A start is followed by
phase-qualified intent/outcome pairs in target order. An unfinished intent is
uncertain; failed/uncertain outcomes stop progress. A `phase-checked` event binds
the expected whole projected path/hash map after every target in that phase.
Only then may the next phase begin, even when a phase has no targets. Both phase
checks are necessary for event-chain completion; completion is not activation.

The same path can occur once in each phase, without flattening targets or losing
which write an outcome describes. The future executor must obtain actual target
readback evidence, enforce approval and bind transaction recovery to this model.
This pure helper neither reads nor creates journal files. Its chain
uses canonical event digests, not hashes of serialized file bytes. It does not
validate source provenance or attest that asserted filesystem observations occurred.

This is a full, bounded in-memory inspection. Do not call it over all accumulated
events before every persisted append: that would repeat work quadratically.
The internal cursor advances one event at a time; durable writer/head checks are
described below. No retention guarantee is claimed by this helper.

## Internal journal storage

`createSwitchJournal` / `readSwitchJournal` in `switch-journal-store.js` persist
and inspect these events under `.pipeline/journals/<uuid>/`. The writer requires
a live workspace lock, reports the exact directory through `onLocation`, creates
each event exclusively, syncs its file and checks the recorded bytes. A failed
append poisons the writer; neither automatic append-resume nor repair is offered.
Existing evidence is retained. A read-only reader reconstructs incomplete intents
as uncertain and rejects malformed, reordered or incorrectly bound events.

Each append checks the last file's byte hash, while the event chain uses canonical
digests. Full audits occur at initialization, both phase checks and failed/uncertain
outcomes. Older prefix corruption may only be found at these audits, not the next
append. Tests count head reads and audits; there is no complete performance benchmark
or guarantee against concurrent hostile filesystem access/power loss.

This storage is internal and not connected to the public CLI. Storage primitives
alone grant no activation or write authority. The lifecycle and history readers
described below bind the exact prepared switch, approval, snapshots and recovery
envelope. Do not bypass those checks or create real workspace switch journals
through these low-level APIs.

## Recovery envelope (structural binding)

`switch-records.js` validates a prepared switch against an exact approval digest
and previous state, then builds a `switch-recovery` envelope bound to one journal.
It reconstructs the two-phase preview, checks the full-removal record and required
backup inventory, and retains both snapshot descriptors. The envelope is detached
and digest-bound; a wrong approval, replaced phase, missing backup descriptor or
modified recovery snapshot is rejected. No synthetic nested approval is created.

These helpers perform no I/O. `sourceVerification` is a claim from preparation,
not proof re-established by record validation. The envelope does not demonstrate
that its journal exists or that snapshots/backups have been durably installed.
`activationSupported` stays false. Locked adapter/source replay, persistence and
generic recovery/history integration remain required before execution is enabled.

## Locked preflight

`verifySwitchApproval(lock, prepared, approval, registry, previous)` in
`switch-preflight.js` detaches and validates the exact record before awaiting,
requires a live lock, and verifies actual state bytes, full old-package removal
replay (including backups), incoming origin and staged package bytes. Staging
directories must exist outside and not contain the workspace. It reconstructs
the incoming adapter plan against the approved projected post-removal observations
and compares the exact result and observation scope.

State, source, removal and target observations are repeated after asynchronous
adapter execution. This preflight does not fetch Git, write recovery records,
modify provider files, or activate anything. It returns `applySupported: false`.
Passing it is not a reusable capability: the executor must recheck relevant
dependencies at persistence/write boundaries and handle intervening external edits.

## Prerequisite persistence (internal, no target writes)

`persistSwitchRecovery` in `switch-recovery-store.js` performs locked preflight,
bounds the recovery record, copies/verifies the new snapshot, initializes one
phased journal and exclusively writes/syncs/readbacks the associated recovery file
at `.pipeline/transactions/<same-uuid>/recovery.json`. Preflight and durable
evidence inspection are repeated before returning exact recovery hash and paths.
No journal writer capability, pending/active transition or target write is returned.

`readSwitchRecovery` checks record/journal identity, both persisted snapshot trees,
old backup hashes and the event chain without requiring the temporary source
directory. It does not inspect current provider-target state or authorize resumption.
Partial/orphan metadata is retained on errors, including an unusable recovery file.
There is no automatic retry, deletion or generic-history bypass. Executor and
activation helpers perform their own current-state checks.

Incoming ownership backups are derived by `incomingSwitchBackups` from approved
post-removal observation bytes. Whole-file hashes and owned JSON-field before
values are verified separately; backups retain the entire observed file. All
existing backup collisions are checked before creating new backups. An identical
backup is reused; different bytes at the same path cause failure, not overwrite.
Backups are saved before journal/recovery creation and checked by recovery reads.
Descriptor derivation is deterministic from the frozen preview, so no additional
recovery-record field or historical record rewrite is introduced. Legacy field
backup collisions with changed foreign siblings fail closed and are not resolved
automatically by this step.

## Pending transition (internal)

`markSwitchPending` in `switch-pending.js` requires the exact persisted recovery
path/hash, a live lock and current explicit approval. It verifies the untouched
start-only journal, replays preflight, stages state bytes, repeats checks before
rename and verifies the resulting state file. Old active deployment and activation
history remain unchanged; status becomes `needs-reconciliation`.

For switch, `pending` binds the canonical recovery-record digest (including the
unique journal identity), not merely equal desired bytes or a repeatable preview.
Generic readers must learn this switch-specific binding before public routing.
Interruption after rename leaves pending state; no rollback or false ready result
is attempted. Scratch/evidence files may remain on failure. The helper does not
write provider targets or authorize their execution. Advisory locking does not
exclude hostile same-user OS races.

## Pending inspection

`inspectPendingSwitch(workspace, recoveryPath)` verifies exact pending-state binding
to this transaction, durable evidence and actual target bytes. It reconstructs the
expected intermediate state from completed events in phase order. For interrupted
intent/uncertain outcome it distinguishes `uncertain-before`, `uncertain-desired`
and `conflict`; seeing desired bytes never manufactures a completed outcome.
Other observed paths must match the intermediate projection, including unchanged
dependencies. It repeats state/evidence/target checks to reject observed drift.

The result always remains `needs-reconciliation` with `executionAllowed: false`.
Journal completion, if present, is reported separately and is not activation.
It neither writes nor resumes an operation, and is not yet wired into generic
doctor/history. No atomic snapshot or hostile-concurrency guarantee is implied.

## Explicit phase execution (internal)

`executeSwitchPhase` accepts one phase name, exact recovery path/hash and current
approval. It verifies the pending transaction and intact intermediate files,
reopens only an intact `open` journal at its verified head and executes that phase.
Installation cannot be selected while removal is current. Uncertain or stopped
chains cannot be reopened through this entry point.

Each target gets a durable intent before mutation and a completed outcome only
after readback. Existing checked file-write/delete primitives are reused with
unchanged bodies. State/recovery hashes and all projected observed paths are
checked around writes; journal head checks remain incremental. Full evidence and
snapshot audits occur at phase entry/exit, not before each append. Prefix/snapshot
drift may therefore be detected at the boundary rather than at the next target.
This is not an overall linear-time claim: target dependency scans still cover the
whole observed scope at each write.

Both phases share one journal. Phase completion verifies the intermediate state
and records its projection check. Even after both phases, state stays pending;
no active-deployment promotion or user-ready claim is made. An error after intent
retains uncertainty and blocks ordinary rerun; no outcome is invented or history
rewritten. History/doctor integration and explicit continuation are described
below; nothing is exposed as a public CLI command.

## Final activation (internal)

`activateSwitch` requires exact recovery hash, current approval, live lock, both
completed phase checks, matching pending identity and conflict-free final files.
It stages and rechecks the transition before rename. The new deployment becomes
active with an anchor containing recovery path/byte hash and terminal journal
sequence/byte hash; pending is cleared. Snapshots, backups, approvals and journal
history are not rewritten. Runtime remains `not-run`.

`inspectActivatedSwitch` confirms the exact active deployment and anchor, completed
journal and final file hashes with repeated dependency/target checks. It can establish
that activation was written after an interruption at rename, without reapplying.
A returned `applied` is local configuration evidence, not live-provider readiness.
Generic doctor/history recognize these records as described below. Public write
routing is still absent. Uncertain phases require the separate continuation path.

## History and doctor integration

History dispatches exact `switch-recovery` records to the phased evidence reader,
retaining unfinished/orphan/corrupt diagnostics and normal predecessor-anchor
checks. Historical switch verification uses stored evidence, not today's target
bytes. Completed journal status alone still does not prove activation.

Doctor selects the exact active anchor, or identifies a pending switch by its
unique recovery digest. Switch readiness uses exact activation/final-projection
inspection; pending switches always remain non-ready. A stale explicit selection
or invalid historical predecessor cannot be hidden by a valid current switch.
Native setup/update/repair/removal dispatch and field projections remain unchanged.
Switch-specific comparison is conservative and exact; it does not yet extend native
foreign-field projection allowances to completed switch results. Public switch
execution and release qualification remain pending; internal continuation follows.

## Continuation preview (read-only)

`prepareSwitchContinuation` binds a proposed new continuation to the exact pending
recovery, journal sequence/canonical head/byte head, state bytes and observations.
For a conflict-free uncertain operation, before bytes select
`retry-approved-target`; desired bytes select `verify-desired` without a duplicate
write. Remaining approved targets and phase checks are listed in original order.
Equal before/desired hashes also select verification only.

The preview is digest-bound, `applySupported: false`, and requires fresh approval.
It rechecks dependencies before returning and never rewrites the predecessor or
marks its uncertain outcome completed. Foreign changes and failed journals are
rejected. Verified clean boundaries use the rules below. Recovery/journal lineage, execution and resolution of
historical unfinished diagnostics are separate helpers described below.

## Continuation approval verification (internal, read-only)

`verifySwitchContinuationApproval` accepts only an exact `decision: approve` and
`previewDigest` binding. It detaches caller inputs before awaiting, validates the
preview digest, checks the live workspace lock, and reconstructs the preview from
current recovery, journal, state and target observations. Any changed dependency
or observation invalidates the old approval. The lock is checked again at return.

This is a point-in-time read-only check, not a durable authorization receipt or
permission to append to the old uncertain journal. `applySupported` stays false.
Future execution must recheck its dependencies at mutation boundaries; advisory
locking does not prevent unrelated programs from editing files.

## Continuation event model (internal, pure)

`createSwitchContinuationCursor` interprets a new chain for an already verified
continuation preview. The start event binds the exact predecessor descriptor;
later events bind the preview digest and previous event digest. It never appends
to the predecessor. Retry operations require intent and outcome. A first target
marked `verify-desired` instead accepts readback without a write intent. Both
paths require the desired hash for completion and ordered phase projection checks.

An unfinished intent remains uncertain; failed/uncertain outcomes stop the chain.
An invalid append poisons the cursor. A completed chain is not activation or
runtime evidence. Validation here is structural and sequencing only, not proof
that predecessor files, approval or observed bytes exist. Event storage is
described below, as are locked execution and history resolution. This model does not
make continuation available through the CLI.

## Continuation journal storage (internal)

`createSwitchContinuationJournal` verifies exact approval under the workspace
lock before creating a fresh UUID journal. Location callbacks report planned,
created and initialized paths. Approval/dependency checks are repeated around
initialization callbacks. The predecessor journal is never a valid destination.

Events use exclusive creation, sync and byte-hash readback. Appends check the live
lock and previous file hash; full replay runs at initialization, phase boundaries
and stopped outcomes, not on every event. Prefix corruption may therefore be
detected at a boundary rather than at the next append. IO/validation failure
poisons the writer and preserves partial files. `openSwitchContinuationJournal`
can reopen only an audited open chain with the expected byte head; uncertain or
failed chains cannot reopen. No cleanup is provided here.
`readSwitchContinuationJournal` performs a bounded read-only event audit against
the supplied preview. It does not prove approval, live target state or resolution
of the predecessor's uncertainty.

This is internal evidence storage only. It does not write provider targets or
change pending/active state. The recovery wrapper below persists the binding;
execution-boundary checks and generic history integration are separate helpers
before continuation can be exposed through the CLI. Separate chains created
here are not treated as automatic permission to execute or as resolved history.

## Continuation recovery binding (internal)

`persistSwitchContinuationRecovery` stores a strict `switch-continuation-recovery`
record beside the new chain, using the same UUID for transaction and journal.
The envelope includes the exact preview, approval and new journal path. The full
record is size-bounded before writing; exclusive creation, sync and hash readback
are followed by repeated locked approval and evidence checks. Partial records
remain on failure. No mutable writer or execution permission is returned.

`readSwitchContinuationRecovery` checks the envelope, UUID binding, predecessor
recovery byte hash, original snapshots/backups and exact old journal position.
It reconstructs the interrupted target, remaining approved operations and
historical observations from the immediate predecessor's plan and journal, with
the original switch verified through the ancestry chain. Both old dependencies
and the new journal are rechecked for drift. Stored hashes are integrity bindings,
not signatures or authentication of a human decision.

This reader checks historical evidence independently of current target files.
An intact record can remain readable after a user edit, without authorizing that
edit or continuation. Selection, target execution guards, final activation and
generic history resolution are described below. The
old uncertainty is not relabelled successful by record creation or validation.

## Selecting the pending continuation (internal)

`markSwitchContinuationPending` requires the exact recovery byte hash, matching
stored/current approval and an initialized one-event continuation journal. It
revalidates the preview against the old pending state, stages a new state file,
then repeats evidence, approval, staged-byte and current-state checks before
rename. Only `pending` changes: its new digest identifies the exact continuation
record (including its unique journal), not just the same desired configuration.
The active deployment and previous activation anchor are retained.

`inspectSelectedSwitchContinuation` verifies that exact pending identity and
historical evidence, including after interruption following rename. It does not
claim current target readiness: `executionAllowed` remains false. Errors preserve
staged or renamed state rather than rolling back. An ordinary rerun against the
old pending state fails after selection; the original switch executor also cannot
continue under the new identity. No public command is added here.

## Continuation execution, activation and history

`executeSwitchContinuationPhase` executes exactly one selected remaining phase.
It checks the recovery byte hash, stored approval, exact pending state, journal
head and projected target bytes. A verified desired first target gets readback
only; retries and later targets receive intent/write/readback/outcome. It reuses
checked file primitives. State, recovery and observed targets are guarded around
writes; full evidence audits run at phase boundaries. This is not an OS-wide lock
or an overall linear-time claim. Failed writes preserve uncertainty.

`activateSwitchContinuation` requires a completed chain, conflict-free final
projection and matching selected state. It stores the new desired deployment
with an exact continuation recovery/head anchor, repeating checks before rename.
`inspectSwitchContinuation` checks pending projection or exact completed active
state, including activation readback after a crash. Runtime remains not-run.

History retains the original uncertain status and adds `resolvedBy` only after
verifying a completed continuation against that exact predecessor. This removes
only its unfinished diagnostic, not corrupt/orphan diagnostics. Doctor recognizes
pending continuation digests and exact activation anchors; stale selections and
invalid dependencies cannot claim ready.

An interrupted continuation may now be the predecessor of a fresh, explicitly
approved continuation. `readSwitchLineage` performs two iterative ancestry passes,
rejects cycles and allows at most 32 continuation links plus the original switch.
Preparation rejects exceeding that budget before creating the next journal.
Every link binds exact parent bytes and journal position; the original switch
supplies snapshots, backups and desired installation. Each immediate predecessor
supplies its remaining operations and verified progress. Completed operations
are not replayed, and readback-only authority cannot expand into write authority.
Final activation selects the new record, not a timestamp or equal desired hash.
History resolves the verified ancestors without rewriting them.

## Clean-boundary continuation

A pending original switch or continuation may have an `open` journal with no
uncertain target, or a `completed` journal not yet activated. Fresh continuation
uses `uncertain: null` and binds the exact predecessor head, pending selection,
observed projection and remaining suffix. Completed outcomes are skipped; a
missing phase check is retained even when that phase has no operations left.
Existing readback-only authority stays readback-only, never becomes a write retry.

Both recorded phase checks allow an empty remaining list. Its new start-only
journal is completed structurally; pending selection and activation still repeat
source/ancestry/current-target validation. Neither record creation nor completion
alone declares the installation active. A crash of this new continuation can be
continued again with a new exact approval, within the existing ancestry bound.

History accepts verified open/completed predecessors as well as uncertain ones
only through validated lineage. It preserves their original records and statuses.
No timestamp selection, inferred outcomes, replay of completed writes, or reopening
of the predecessor journal is permitted. Failed or corrupt chains stay rejected.
This bounds one ancestry read; scanning all history is not claimed to be linear.

Repository moves, documentation relocation, changing layout, same-pipeline updates
and partial provider removal are not this switch preview's scope. Caller-defined
payloads are private and may contain config secrets; do not publish them as logs.
