# Legacy Unity migration — internal synthetic implementation

S10 is in progress. CLI preview, inspection and explicit apply are available for
synthetic testing; independent review and real deployment approval remain pending.

## CLI preparation and inspection

`workspace-pipeline migration unity preview --workspace <absolute-wrapper> --manifest <absolute-manifest>`
prepares the complete proposal, staging committed Git source outside the wrapper.
Add `--network` only to permit remote acquisition. Keep the JSON private: it can
contain full config bytes. The command does not disable plugins or install files.

`workspace-pipeline migration unity inspect --workspace <absolute-wrapper> --recovery <relative-record> --phase <phase>`
inspects one explicit saved migration without writes or source acquisition.
Phases: `deactivation`, `installation`, `recovery`, `closeout`, `compensation`.
Each selects the corresponding narrow internal planner described below. Unknown
phases, path escapes, duplicate flags and `--apply` are rejected. Exit 0 means a
proposal was prepared, NOT installation readiness or approval. Blocked proposals
return nonzero. To authorize exactly a saved proposal, use the separate command:

`workspace-pipeline migration unity apply --workspace <absolute-wrapper> --preview <absolute-preview-file>`

This verb is explicit authorization of the saved installer-bound envelope. It
accepts no source/network/phase overrides. Initial migration runs deactivation,
installation and validated closeout under its lock. Recovery/compensation previews
execute only their selected bounded operation; a phase result may still require a
fresh closeout preview and approval. Exit 0 means completed or legacy-restored;
exit 1 means needs-reconciliation, exit 2 means rejected/error (writes may have
occurred before an I/O failure). Inspect the reported recovery/log paths; never
infer rollback from nonzero exit. Stop harness sessions/config editors before apply.
Private records remain under .pipeline/migrations; do not delete active recovery
evidence. No automatic cleanup or publication occurs.

CLI output now wraps the inner proposal in `installer-bound-migration-preview`.
Its installer identity hashes `package.json`, `src/` and `schemas/`, independently
of installation directory. Verify this envelope before future apply; changed
installer payload requires a new preview. This does not version-pin project docs,
the harness or model. Docs/tests are excluded from this executable-payload identity.
It is not a publisher signature, a hash of tar compression bytes, or verification
of installed dependency contents. `npm run test:packed:identity` tests identity
through an offline tarball install and rejects a changed installed payload.
prepareLegacyUnityOptOut is a pure byte transformer, not a writer or approval.
It disables only unity-sdd-pipeline@unity-sdd in the supplied local Codex/Claude
configuration. Other bytes are preserved. Missing/ambiguous activation and active
inline TOML ancestors fail closed. No global settings are accepted implicitly.

The coordinator binds the wrapper, exact before/after bytes and approved source;
the public CLI additionally binds the installer payload. Prefetch and conflict
checks precede legacy deactivation.
Existing AGENTS.md/CLAUDE.md require explicit takeover and private backups.
Global caches, game and docs remain outside scope. Old .unity-sdd markers are not
ownership. The transformer alone is neither a migration nor recovery mechanism.
Interrupted operations need observed-state reconciliation under the CLI lock and
fresh continuation/compensation approval, never blind rollback. Users must stop
active harness sessions. Do not deploy until the complete route is reviewed.

The configuration-only deactivation record includes both complete before/after
payloads and hashes. Treat it as private: foreign settings may contain credentials.
Validation rebuilds the narrow transformations instead of trusting caller hashes.
Inspection classifies each current target as before, after, unchanged-disabled or
conflict. It never establishes ownership, authorizes restoration, or writes files.
An independently edited file equal to after bytes is not proof of our execution.
This record has no wrapper/source/approval binding; it is an internal component,
not a complete apply preview. The outer coordinator must supply those bindings.

Read-only preflight now acquires a committed Git source into external preparation
storage, verifies its inventory and Unity identity, and binds the wrapper plus six
legacy entry/config/marker file hashes. Rechecking uses staged bytes without Git
or network. Existing .pipeline metadata, missing legacy files, changed wrapper
bytes and changed package bytes block this preparation route. No target writes,
entry takeovers, journal or approval are implemented by this preflight. Its digest
is integrity evidence, not authority; native registry/layout validation and a full
apply transaction are supplied by the internal routes below. This inner preflight
does not bind the installer; the public CLI envelope binds its executable payload,
not the tarball bytes, as described above.

prepareLegacyUnityPreview now renders the compiled Codex/Claude adapters and
shared entry against the verified source and workspace manifest. Only AGENTS.md
and CLAUDE.md receive proposed exact-byte takeovers; other foreign collisions
still fail closed. Original entry bytes are retained in the private proposal and
the setup plan declares their native backup paths. No backup file is written yet.

The embedded setup preview uses virtual post-deactivation observations. It is
NOT independently applicable to the current wrapper and must never be submitted
directly to generic apply. The outer migration requires both ordered phases under
one approval and appropriate recovery semantics. It also binds original target
observations and checks the manifest again after rendering. The internal coordinator
below handles deactivation, native installation and same-process finalization.

verifyLegacyUnityPreview binds explicit caller approval to the whole proposal,
checks the selected wrapper and current manifest, verifies staged package bytes
and reconstructs every proposed edit with compiled adapters. Changed instructions,
paths or phase order are rejected even if a caller recomputes the outer digest.
This verification performs no acquisition, writes or locking, and must be repeated
under the eventual transaction guard before writes. It is not an execution capability.

Integration constraint: ordinary setup recovery represents one installation and
cannot truthfully cover a preceding legacy deactivation. Do not manufacture an
old active deployment or record deactivation as init/repair. The final coordinator
must persist both phases and gate all normal lifecycle writers while migration is
incomplete; native doctor/history/continuation must understand the resulting record
before any ready activation is allowed. CLI apply delegates to these checked routes.

Pending guard implemented: presence of `.pipeline/migration-operation.json`
blocks ordinary workspace locks and existing repository/lifecycle entry guards.
It is checked again when a held lock is used, including repository-operation locks.
Empty, malformed, directory and link markers are not parsed as permission to proceed.
History reports incomplete; doctor reports needs-reconciliation, ready=false.
No marker is deleted or auto-repaired. Migration-specific recovery/execution
capabilities were initially unavailable; the internal begin/deactivate route below
now supplies one. Do not create the marker manually in real workspaces. This guard
alone does not perform migration.

## Internal begin and first-phase execution

beginLegacyUnityMigration validates the full approved preview before locking and
again under a process-local migration lock. It first writes a pending marker,
then the private recovery record containing original bytes and approval binding.
Only after both readbacks does it seal the capability. JSON cannot recreate the
capability. Changed/missing marker or changed recovery invalidates it. Ordinary
and repository-operation locks cannot bypass it. The caller must release the
returned lock; failure does not delete recovery evidence or restore targets.

The returned internal deactivate method writes exact Codex and Claude opt-outs
with per-target intent/outcome records under the migration's deactivation directory.
An error stops the remainder. A write followed by an error is uncertain, not
silently successful. A repeated call is not an automatic retry. Final history
readback audits the fixed phase journal. Instructions, skills and game files are
not written in this phase. Result remains needs-reconciliation after success:
the second phase must run separately through the same authenticated capability.

## Internal second-phase installation

The returned install method requires the complete, hash-linked deactivation journal
and exact disabled configuration bytes. Disabled settings alone are not execution
evidence. It delegates installation to native apply, including re-rendering, checked
writes, instruction takeover backups, native transaction recovery and activation.
The full preview approval supplies the subordinate installation authorization;
it is not a new inferred human decision. Source snapshot and Git object preparation
must remain outside the wrapper and present for verification.

An installation locator binds the native journal/recovery to the outer migration
and deactivation result. A second call is not an implicit retry. An interruption
preserves recovery and leaves ordinary lifecycle operations blocked. Even when
native apply returns ready, the outer result is needs-reconciliation: the pending
marker stays in place and doctor must not report readiness until finalization.

## Internal same-process finalization

The returned finalize method requires a completed first-phase journal, exact native
prepared-plan/approval bindings and a successful native recovery inspection of the
current installation. Legacy binding files must remain unchanged. It writes an
exclusive completion record, repeats the checks and removes only the exact pending
marker. Recovery, original backups and journals are retained. Removing the marker
invalidates the migration write capability; the caller must release the lock before
ordinary doctor can report readiness. Readiness covers configuration, not runtime.

Interruption before marker removal leaves the workspace blocked. An existing
completion record is not permission to retry or delete the marker manually.
Supported restart and compensation routes are described below; they require fresh
approval and do not themselves authorize a real-workspace deployment.

## Read-only restart closeout preview

prepareLegacyUnityCloseoutResume accepts an exact persisted migration recovery
path, verifies marker/recovery/preview bindings and both installed phases, and
returns a digest-bound proposal. If a matching completion record already exists,
only marker removal is proposed; otherwise completion creation precedes removal.
Conflicting completion evidence or incomplete installation is rejected. No lock,
write, network acquisition, lease or implicit approval is issued (executable=false).
This preview covers only the installed-phase restart case. For partial deactivation,
see "Partial deactivation inspection"; for interrupted installation, see "Interrupted
installation preview"; for bounded restoration, see "Explicit pre-install
compensation". Approved closeout execution is described next.

## Approved restart closeout execution

applyLegacyUnityCloseoutResume requires fresh approval of the exact closeout
preview digest. It reconstructs the proposal before acquiring a new process-local
migration lease, checks again under the workspace lock, and saves a separate
authorization record. It creates completion only when proposed, verifies the
result and authorization, and removes the exact marker. Old completion records
are preserved. The lock is released on success or error; no error triggers rollback.
If interruption creates completion, the previous preview is stale: inspect again
and approve the new remaining-operation preview. Tests currently exercise fresh
leases after releasing the former lock, not termination of a live harness process.
CLI apply can invoke this writer only with its saved installer-bound proposal.

## Partial deactivation inspection

prepareLegacyUnityDeactivationResume reads the persisted migration and validates
the bounded first-phase journal prefix (start, intents, outcomes, phase check).
It compares current files with exact before/after bytes and preserves failed or
uncertain history. A desired hash without an intent is not attributed to this
migration; completed evidence followed by before bytes is a conflict, not retry.
Foreign config bytes block the proposal, while unrelated target drift is rejected.
The result proposes write-disabled or confirm-observed actions without executing
them. It rejects the native installation locator/state: partial installation needs
its own recovery route. This is not an executable continuation or compensation.

applyLegacyUnityDeactivationResume is the internal approved writer for that
proposal. It reconstructs the preview, acquires a fresh migration lease/lock and
writes a separate digest-selected attempt journal. It checks surrounding targets
and original evidence before each operation. Observed disabled bytes are confirmed;
remaining exact before bytes can be changed to disabled. Errors preserve uncertainty
and stop execution; original failed/uncertain records remain untouched. Replaying
the same attempt cannot overwrite its journal. Both success and failure keep the
migration blocker. phase-observed alone is not permission to advance to installation
or remove the marker: the evidence verification below is mandatory.

## Resumed-phase evidence at the installation gate

The installation/finalization phase verifier now recognizes exactly one completed
deactivation-resume attempt. It reconstructs the two narrow operations from the
original before/after contract and observed hashes; checks approval, original
journal prefix, unchanged observations, classifications and the six new records;
and verifies record membership/hashes again. Incomplete, tampered or multiple
attempts block the gate. No latest-by-time selection or historical PASS rewrite.
This only supplies phase evidence to existing installation validation; passing
this verifier does not create a write capability. The restart route below requires
a separate fresh approval.

## Fresh installation after recovered deactivation

prepareLegacyUnityInstallResume binds the persisted migration, completed phase
evidence, current target hashes, prepared snapshot and original native setup plan.
It rejects an existing installation locator or state rather than retrying a started
installation. applyLegacyUnityInstallResume reconstructs that preview, requires
its exact approval, acquires a new process-local lease and rechecks under lock.
It saves a separate authorization record and delegates to native installation.
Result remains needs-reconciliation until separately approved closeout. Recovery
of an interrupted native installation is not implemented by this route.

## Interrupted installation preview

An initial setup interrupted after its native recovery record is persisted but
before pending state is published can be continued with a new approved recovery
preview. This requires absent state, validated snapshot/backups, an intact original
journal with no target intents/outcomes and all targets/dependencies still at their
original bytes. It creates a separate transaction; it never fabricates the missing
pending state or rewrites historical evidence. Existing-state updates do not gain
this pre-pending route.

Earlier interruptions with an installation locator but missing/incomplete native
journal or recovery record remain blocked: there is insufficient validated native
evidence for this continuation. Do not remove the marker manually. Repeated failed
continuations remain unsupported as described below.

prepareLegacyUnityInstallRecovery wraps the existing native prepareContinuation,
without a separate target-writing algorithm. It binds migration/marker, completed
first-phase evidence, installation locator and exact original prepared setup to
the selected native recovery. Legacy binding files are checked separately from
native-owned targets. The native planner proposes verify-readback for observed
desired bytes and write-desired for remaining before bytes; conflicts fail closed.
The result requires new approval, stays executable=false and never clears the
migration blocker or rewrites an old outcome.

applyLegacyUnityInstallRecovery reconstructs a newly approved preview, acquires a
fresh migration lease and uses native applyContinuation. A separate authorization
and exclusive continuation locator bind the new native recovery to this migration.
Closeout checks the exact authorized continuation and its native lineage to the
original interrupted setup before accepting the new activation. It does not use
an unrelated ready state or overwrite original recovery. The migration blocker
remains until separately approved closeout. An interrupted continuation remains
blocked; repeating it is rejected. Multi-continuation selection/recovery is pending.

## Explicit pre-install compensation

prepareLegacyUnityCompensation and applyLegacyUnityCompensation cover only the
original deactivation attempt before native installation or resumed deactivation.
Existing native preparation/state or resumed-attempt records block this narrow
route. A new digest-bound approval authorizes restoration of the two exact original
local configuration files and marker removal after complete verification. It never
changes shared caches, global settings, instructions, game files or documentation.

Separate compensation intent/outcome records preserve the original history. An
error stops writes and retains the marker; no implicit retry/rollback follows.
Success returns legacy-restored, not ready for the new pipeline. Migration evidence
and .pipeline metadata remain; this is not metadata cleanup or authorization for
another setup. Compensation after installation/resumed attempts and recovery of
an interrupted compensation remain unsupported.

These writers and CLI apply remain development-preview functionality.
Real application requires a separately approved real-wrapper preview. Only the
bounded resume and pre-install compensation routes described above are supported.
Repeated interrupted recovery attempts, multiple installation continuations and
post-install compensation remain unsupported; do not clear the marker to bypass
these limitations.
