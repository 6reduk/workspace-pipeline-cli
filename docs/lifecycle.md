# Setup/update coordination (S6 development)

Internal APIs only; public CLI routing and real provider adapters remain pending.

`prepareLifecycle(input, registry)` prepares an explicit setup or update command.
It can acquire a Git source into temporary storage outside the workspace, but
does not edit provider configuration or approve its own output. A wrong verb for
the current installation is rejected. Incomplete history blocks preparation.

`applyLifecycle(input, registry, {report, retention})` takes the exact prepared plan and a
separate approval, acquires the workspace lock, rechecks state/history and invokes
native apply. Callers must coordinate stopped configuration consumers; neither an
approval nor this lock proves that outside harness sessions have stopped.

The registry and reporter are trusted caller code, never loaded from the pipeline
source. Reporter events contain paths and status, not credential-bearing contents.
CLI wiring must provide a reporter to actually print early events.

Journal location events: `planned` (no creation claim), `created` (directory exists),
`initialized` (start record checked). They include absolute path and run ID.
Recovery location events: `created-unverified`, then `verified` after readback;
before creation its intended path is labelled `not-created`.

The final result preserves the last observed location statuses, including failure
after journal creation but before recovery. A failure before journal allocation
reports null journal/recovery. A forced kill cannot guarantee a final message.
Reporter failure during execution stops it; partially written evidence is retained.
Failure to emit the final result does not rewrite an already successful operation:
`outputError` is separate. Lock release failure is likewise separately reported.
No rollback, cleanup, force-unlock or retry is implied by a failure report.

The optional `retention` argument is a separately approved exact cleanup preview,
not an implicit setup permission. It runs under the same lock after read-only
main preflight and before the new journal is created. A failed cleanup/report
prevents setup/update from starting; its own result stays in `result.cleanup`.
Main preflight is repeated afterwards. See [retention](retention.md) for limits;
an explicitly enabled local automatic policy is also supported. Manual startup
cleanup plus automatic policy is rejected. Public setup/update routing remains pending.

Repeated update with unchanged desired deployment remains valid: doctor verifies
every matching recovery record, and recovery distinguishes completed no-op state
from before-state using the completed journal, not equality of state bytes alone.
