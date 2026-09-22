# Repair and reconciliation previews (S6 in progress)

Internal APIs only. No public repair command yet.

`inspectRepair(workspace, registry)` replays installed snapshot bytes through
trusted adapters and checks that generated owned values match recorded hashes.
Missing source Git/manifest does not trigger a fetch or latest-version lookup.
Changed adapter output is rejected. Current user edits remain conflicts.

`prepareRepairPreview(workspace, registry)` produces exact payloads for missing
owned files/fields, preserving foreign JSON siblings. Any conflict blocks ALL
targets in the preview. It does not silently take over changed files or approve
itself. Outputs can contain configuration secrets from preserved siblings: keep
this envelope local, never print it as diagnostic output or publish it.

`previewReconciliation(workspace, exactRecoveryPath)` binds the current state and
selected recovery/journal evidence. It preserves uncertain writes even where
current bytes equal desired bytes. It does not replay, roll back, clear pending
state or release an abandoned lock.

Inspection/preview results have applySupported=false, automaticActions=false,
runtime=not-run and require fresh approval. They are not executable envelopes.

`prepareRepairPlan(workspace, registry)` binds a native operation with command
`repair` to the exact current state, all owned dependencies and missing-target
payloads. Its `prepared-repair` envelope preserves the entire active deployment,
including version, identity, ownership and original backup lineage. It rejects
conflicts; it does not select a new source/version or manufacture an approval.
Absent JSON files use create with no field-edit operations; existing JSON files
use edit-fields with exact absent-field preconditions and preserved siblings.

`verifyRepairApproval(lock, prepared, approval, registry)` is read-only preflight:
it requires the fresh exact digest approval, verifies a live workspace lock and
rebuilds the complete plan from installed bytes. Changed state, payloads, foreign
siblings, unchanged managed dependencies or adapter output invalidate the plan.

`prepared-repair` now has applySupported=true for the internal `applyRepair`
entrypoint only; setup/update apply still rejects it. `applyRepair` replays under
lock, verifies existing backup lineage, and uses the shared journal/write/readback
transaction engine. It rechecks the fresh plan after recovery metadata is staged
and before pending state or provider targets are written. No Git source is needed.

`inspectRecovery` understands repair records, requires an unchanged deployment
and preserves uncertainty after interruption. This is inspection, not automatic
retry/rollback. Internal continuation execution is described below; public CLI
routing remains unimplemented. Doctor checks all matching records and explicitly distinguishes
owned JSON fields from foreign siblings in completed historical transactions;
exact-byte recovery inspection remains the default. Full regression still needs
checking before S6 completion. All envelopes with bytes remain private and potentially
secret-bearing.

`prepareContinuation(workspace, recoveryPath)` creates a separate
proposal for an exact pending transaction. It binds state, recovery bytes and the
journal head (sequence/hash). Desired targets require new `verify-readback` actions;
untouched targets get `write-desired` actions. Other bytes or invalid evidence
block the whole proposal. Unchanged dependencies and exact stored output bytes
are included. No old outcome is rewritten or presumed successful.

`verifyContinuationApproval` reobserves the proposal under a live caller-owned
lock and requires its fresh digest approval. Changes to journal head, state,
targets or payload invalidate it.

Internal `applyContinuation` executes that exact approval in a NEW transaction.
Already-desired targets receive a new journaled readback without file writes;
remaining writes use immediate before-hash checks. Existing backups are verified,
not replaced. Before activation, original recovery bytes/journal head and the
exact original target/payload/dependency relationship are rechecked. Historical
uncertainty is never rewritten as a successful original outcome.

Doctor/history validate completed continuation evidence and mark the exact old
entry as resolved by that continuation, preserving its original status and bytes.
Historical completion is distinct from activation/current configuration readiness.
Nested continuation (continuing a failed continuation) verifies the complete
ancestry iteratively, preserving every ancestor's bytes and approval. Repeated
paths are rejected as cycles. The maximum is 32 continuation links; preparing
another beyond that bound fails before execution and retains pending evidence.
History resolves all verified ancestors only through completed descendant evidence.
Public CLI routing,
compensation and abandoned-lock removal are not implemented. This is an internal
executor with applySupported=true, not a complete user-facing recovery workflow.
