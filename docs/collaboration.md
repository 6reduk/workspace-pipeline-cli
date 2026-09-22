# Collaboration contract

Scope: multiple harnesses may be configured in one workspace. This does not make
concurrent edits safe or create a distributed lock.

## Task owner and handoff (CON-03)

One owner controls each active task/artifact scope. Record task ID, owner, files,
source revision/before hashes, current step, unresolved questions and handoff target
in the project's task artifacts, not in machine-local installer state.

Before an overlapping edit, the next agent reads that handoff, checks the before
revision/hashes and explicitly takes ownership. Conflicts stop the edit; old approvals
are not silently reused for changed subjects. Review independence must be disclosed.
Independent agents can work on disjoint scopes only with explicit ownership.

The CLI does not orchestrate agents or certify their compliance with these rules.
A task claim is advisory, not a lock preventing all harness writes.

## Installer exclusion (CON-01/02)

The internal S5 coordinator acquires its lock through the caller: one exclusive
lock per canonical workspace. It rechecks before bytes and stops the remaining
operation plan on drift/failure. A second workspace remains independent. Abandoned
locks are preserved; neither age nor a recorded PID authorizes deletion.

Before update/remove/switch/repair, coordinate and stop sessions using the affected
configuration. The CLI cannot reliably discover every outside agent/editor or revoke
already loaded instructions. Synthetic Windows tests cover separate-process
exclusion, interrupted writes and read-only recovery. CLI lifecycle commands and
real harness behavior are not implemented/certified by those tests.

Recovery requires the exact transaction record and never resumes execution,
rolls back, clears a lock or guesses the latest transaction. A stop before recovery
publication may leave an orphan start journal; preserve it as inert evidence.
Interrupted replacement staging files are also preserved, not safe to delete by
glob. Pending-state resolution needs an explicit scoped lifecycle operation;
until that command exists, the workspace cannot be automatically repaired.

The prepared preview checks the inline recovery budget (2 MiB and 50k parser nodes)
and refuses oversized plans with `plan.recovery-budget` before returning a preview
for approval. Split work into smaller plans; source blob limits are not deployment
envelope limits. Apply still validates the actual serialized records before writes.

Journal appends check the current head and new record. Full history is checked at
terminal result, activation and recovery: older-prefix damage may be detected at
those later gates, never treated as a valid completed transaction. This bounded
detection latency and cooperative locking are not hostile-OS protection. Power
loss/directory durability, ACL behavior and non-Windows execution remain unverified.

## Across developers and machines (CON-04)

Use branches/worktrees plus review and a shared task authority in Git or the selected
board. Each developer owns their local wrapper; shared documentation belongs in the
declared repository. Do not commit credentials, machine-local state or secret-bearing
backups.

A local workspace lock is not a distributed lock. Installer readiness, live harness
discovery, safe parallel operation and producer acceptance are separate claims.
