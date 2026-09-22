# Technical journal retention

The internal `scanRetention(workspace, {policy, now, currentRuns})` API produces
a read-only filesystem preview. Explicit CLI cleanup is available; automatic
startup deletion is not enabled.
Policy requires explicit `maxAgeDays`, `maxJournals`, `maxDeletesPerRun`; no defaults
are silently selected by a pipeline package.

The scan reports absolute journal/recovery paths, status, byte counts, exact file
hash/mtime inventory and protection reasons without returning record contents.
Age uses local metadata modification time, not an inferred activation timestamp.
The active transaction is always selected by explicit state/record bindings.

Current state/current run, incomplete records, corrupt/unknown/orphan evidence
and retained references are protected. References are conservatively collected
from record paths: even an eligible record protects the history it references.
Ambiguous inventory or state protects all groups. Only unreferenced completed
groups can be selected by age OR count, oldest first, subject to the per-run cap.
Protected entries still contribute to totals and unmet limits.

The scanner inspects exact UUID groups, permits only sequential JSON event names
and recovery.json, refuses links/foreign files, bounds reads to 10,000 files and
64 MiB, and repeats inventory, hashes, timestamps, history and state checks.
This is not an atomic filesystem snapshot. The locked cleanup executor revalidates
before mutation and preserves diagnostics for partial deletion.

Backups, snapshots, repositories, provider configs and project documentation are
outside deletion scope. Do not remove `.pipeline` wholesale. The preview's
`applySupported` and `automaticActions` remain false: it is a proposal, not an
execution capability. `applyRetention` performs its own locked validation.

## CLI usage (development checkout)

`logs list` also includes a `repositories` section for the S7 repository journals,
evidence, authorization chains, completion records and bootstrap/recovery locations.
This includes `.pipeline/repository-lock-recoveries/<digest>/` archives; their
original owner records and recovery receipts remain protected from cleanup.
It reports absolute paths only, not record contents. `validation: locations-only`
means directory discovery, NOT semantic validation of journal chains or proof of a
completed operation. Its `complete` flag describes this bounded listing only.

S7 entries have `deletionEligible: false` and are not selected by `logs clean` yet.
Do not manually clear a pending marker or bootstrap/recovery lock to bypass an
unfinished operation. S7 age/count/per-run retention remains unimplemented.
Sibling `.wpc-bootstrap-history-*` entries are attributed using the exact workspace
in their owner record; malformed associations are reported as incomplete. Enumeration
is bounded to 1,000 relevant entries/candidates and 100,000 parent directory names;
exceeding a limit is incomplete, not an empty successful listing. Links are not followed.

Run from the CLI repository, replacing `C:/Work/Game` with your wrapper:

```powershell
node ./src/cli.js logs list --workspace "C:/Work/Game"
node ./src/cli.js logs clean --workspace "C:/Work/Game" --max-age-days 30 --keep-last 20 --max-delete 5 | Set-Content -Encoding utf8 "C:/Work/cleanup-preview.json"
```

The numbers are examples, not defaults. List chooses no retention policy and
never deletes. Inspect the saved preview: selected IDs, absolute paths, byte
counts and protection reasons. Then explicitly apply that same file:

```powershell
node ./src/cli.js logs clean --workspace "C:/Work/Game" --apply --preview "C:/Work/cleanup-preview.json"
```

Changed state, records, timestamps or inventory invalidate the preview. Generate
and inspect a fresh one rather than forcing it. `--apply` cannot be mixed with
policy flags and does not silently substitute a newly computed selection.

## Deletion and failure reports

Only enumerated event/recovery files and then empty group directories are
removed. No recursive deletion is used. Each remaining recovery record and state
is checked before every file deletion to detect new references; this conservative
check has cost proportional to selected files times retained records, bounded by
scan limits and the user deletion cap. It is not a linear-cost guarantee or an
OS-wide defense against hostile concurrent filesystem writers.

Progress is emitted as JSON on stderr; final JSON is on stdout. The receipt path
is under `.pipeline/cleanup/<run-id>.json`. Receipts record selected file hashes,
confirmed deletions, reclaimed bytes, current intent and failures. These receipts
describe attempted/deleted paths; unlike operational recovery records, they are
not dependencies requiring deleted file contents to remain. Deletion is not
recoverable by this CLI. A crash may leave an intent without confirmation;
do not treat that as successful cleanup. Partial groups are protected by later
scans; locks are never stolen and cleanup does not auto-resume or roll back.

Exit 0 means the requested cleanup completed, 1 means an incomplete/failed result,
2 means invocation/preflight failure. Output transport can fail independently of
filesystem completion; check the receipt rather than blindly retrying. Cleanup
receipts from actual deletions are retained under v1; only an explicitly selected combined v2 policy
or manual combined preview may rotate eligible completed receipts.

## Setup/update startup integration (internal coordinator)

The trusted caller may pass `retention: {preview, approval}` alongside the
`report` option to `applyLifecycle`. The approval is the separate exact cleanup
approval `{decision: 'approve', previewDigest: preview.digest}`; approving the
installation alone does not authorize deleting history. The saved preview shows
all three user limits. No policy is loaded from the pipeline supplier and there
are no implicit numeric defaults. A separately enabled local automatic policy is
described below; combining it with this manual startup option is rejected.

The coordinator holds one workspace lock, preflights the main operation before
cleanup, announces the validated policy, applies the exact cleanup, then repeats
history and installation checks before any setup/update target writes. The new
operation's journal is created only after cleanup; existing active/pending
history is protected by the scanner. Read-only commands never enter this path.

Results contain a separate `cleanup` result including its receipt path when
available. Cleanup failure or a failed cleanup report prevents the main operation
from starting (`status: 'not-started'`). If cleanup succeeds but setup/update
subsequently fails, the completed cleanup remains reported separately; it is not
rolled back or presented as successful installation. Invalid main approval fails
before cleanup. Locks are released normally; abandoned locks are not reclaimed.

Public setup/update use this coordinator and the separately configured local
retention policy. They do not accept implicit cleanup defaults.

## Local automatic policy

`.pipeline/retention.json` is user-owned wrapper metadata, not pipeline content.
Missing means disabled, with no limits invented. Invalid existing bytes block
mutating startup instead of falling back to defaults. A strict v1 record contains
`schemaVersion: 1`, `kind: "workspace-retention-policy"`, the absolute `workspace`,
`mode` (`automatic` or `disabled`), and `journals` with all three existing limits.
Unknown fields, duplicates and unsafe numeric values are rejected. Copying the
file to a different workspace does not grant cleanup there. Schema version is
data compatibility, not a project-task gate.

Development-checkout commands (example numbers are not defaults):

```powershell
node ./src/cli.js logs policy show --workspace "C:/Work/Game"
node ./src/cli.js logs policy set --workspace "C:/Work/Game" --mode automatic --max-age-days 30 --keep-last 20 --max-delete 5 | Set-Content -Encoding utf8 "C:/Work/policy-preview.json"
node ./src/cli.js logs policy set --workspace "C:/Work/Game" --apply --preview "C:/Work/policy-preview.json"
node ./src/cli.js logs policy disable --workspace "C:/Work/Game" | Set-Content -Encoding utf8 "C:/Work/disable-preview.json"
node ./src/cli.js logs policy disable --workspace "C:/Work/Game" --apply --preview "C:/Work/disable-preview.json"
```

Inspect the preview before apply. Enabling automatic mode authorizes **future**
eligible journal deletions within the chosen limits. These configuration commands
do not delete history or install a pipeline. Writes verify exact before bytes
under lock. Disabling preserves limits; absent policy is already disabled.

The internal setup/update coordinator reads this file after main preflight and
selects eligible groups afresh. Policy path/hash, limits, protected count and
unmet totals are reported before removal. Receipts distinguish `workspace-policy`
authority (exact policy hash) from `approve` (exact manual preview digest).
The executor checks policy bytes at deletion boundaries; drift stops cleanup.
There is one bounded pass per invocation, with no automatic + manual double budget.
Read-only commands never run it. Supplier configuration is not read as user policy.
The file/digest is not tamper-proof against a process already able to write the
user’s filesystem. Policy itself is not part of immutable deployment approval.

## Combined receipt retention (explicit v2 opt-in)

`planCombinedRetention` independently computes age/count candidates for journals
and receipts, then merges them oldest-first under one deletion cap. Typed identities
keep equal UUIDs across classes distinct. This pure output is not deletion permission.
`scanCleanupReceipts` inspects bounded local receipts and operational references,
then rechecks hashes, inventory and history. Only known, internally consistent
completed receipts qualify; current, incomplete, unknown and linked records stay
protected. Missing reference evidence prevents usable cleanup inventory.

`scanCombinedRetention` binds both inventories. The common executor deletes the
selected typed items under one lock and one cap, retaining its own current receipt.
Receipt descriptors describe deleted bytes and do not create immortal dependencies.
Failed/partial/unknown records remain protected. Drift, including policy changes,
stops the pass. No recursive deletion, implicit retry or budget reset is used.

Add BOTH `--receipt-max-age-days N` and `--keep-receipts N` to a `logs clean`
preview or `logs policy set` preview. `--max-delete N` is then the combined cap:
one journal/recovery group or one receipt counts as one item. Apply still uses
only `--apply --preview <file>`. `logs list` shows both inventories read-only.

V2 local policy keeps `journals: {maxAgeDays, maxJournals}` and adds
`cleanupReceipts: {maxAgeDays, maxReceipts}` plus top-level `maxDeletesPerRun`.
The schemaVersion is 2; v1 is not rewritten or expanded automatically. Disable
preserves the schema/limits; an explicit v1 set-preview can withdraw receipt
authority. These versions are CLI metadata, not project governance gates.

Both v1 and v2 create no cleanup receipt if nothing is selected, returning null
receiptPath/runId and zero counts. This deliberately changes v1 no-work output:
callers must respect receiptCreated:false rather than assuming a receipt path.
A successful combined pass creates a schema-2 receipt; later scans validate its
typed inventory and completion before it can become eligible. Current-run and
operationally referenced receipts remain protected. Full release certification
still requires independent review and packaged/live-provider tests.

## Receipt scan bound and manual recovery

The receipt scanner accepts at most 1,000 directory entries (also bounded by
64 MiB). Above that, retention-receipts.limit blocks logs list and combined v2
cleanup previews; it does not certify a partial inventory. V1 can still accumulate
receipts from real deletions. Use explicit v2 receipt rotation before reaching
this bound. Skipping empty v1 receipts does not cure an already oversized directory.

There is no automatic overflow recovery or force-clean command. Manual recovery
is an administrator operation, not permission to delete files by age/name:

1. Stop CLI/harness writers for this workspace and establish that no writer is
   alive. An existing lock requires its documented owner/liveness investigation;
   do not remove it merely to get past this limit.
2. Back up the workspace metadata securely. Receipts and scratch bytes can contain
   private paths/configuration; do not upload them. Record exact paths and hashes.
3. Inspect candidate receipt JSON individually using the current strict completion
   validation, and inspect ALL state, transaction/recovery, journal and retained
   receipt references. Only known, valid, completed, unreferenced receipts qualify.
   Empty legacy v1 receipts still require those checks. Unknown, partial, linked,
   referenced or corrupt entries remain in place. If reference independence cannot
   be established, stop and obtain expert repair; the scan limit is not a waiver.
4. With explicit approval of an exact path/hash list, move only those qualifying
   receipt files to a private quarantine OUTSIDE the workspace until the directory
   has at most 1,000 entries. Recheck hashes and references immediately before
   moving. Use exact literal paths, never wildcards, recursive deletion or moving
   the whole .pipeline directory. Keep the quarantine and move manifest recoverable.
5. Rerun doctor and logs list. Resolve diagnostics before writes, then preview and
   approve a combined v2 policy with explicit receipt limits. Do not blindly restore
   quarantined files into a now changed workspace or delete the quarantine as part
   of this procedure.

## Scratch files left by a crash

Replacement writes may leave .wpc-<uuid>.tmp beside a target; pending-state writes
may leave .pipeline/.switch-state-<uuid>.tmp or .pipeline/.continuation-state-<uuid>.tmp.
They may contain partial or complete private configuration bytes. They are not
deployment state, not eligible journal receipts, and are intentionally not removed
by logs clean or pipeline removal. A name match or old timestamp proves nothing.

For manual cleanup, first stop writers and resolve pending recovery/locks. Establish
the exact file's provenance from the interrupted operation, verify it is a regular
non-linked file, ensure no live writer or recovery step needs it, and compare the
actual target/state against the approved recovery result. If uncertain, leave it.
After exact path/hash approval, move only verified leftovers to secure quarantine
outside the workspace and rerun doctor. Preserve unknown files, provider settings,
backups and snapshots. No blanket .tmp deletion is safe, and this CLI does not
currently automate scratch inventory or reclamation.
