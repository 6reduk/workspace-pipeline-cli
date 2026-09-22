# Repository workspace commands

These commands prepare repository layout only. They do not install a pipeline,
start an LLM harness or MCP server, approve project trust, or modify Git remotes.
Provider configuration requires a separate `setup` plan. `wrap` is an alias for
`adopt`, not a destructive in-place conversion command.

## Inputs and preview

Use absolute paths for command-line paths. A workspace manifest selects the Git
pipeline source, provider names, repository destinations and documentation owner.
See [contracts](contracts.md) for the manifest contract and [source](source.md)
for source acquisition. A separate JSON file makes each repository action explicit:

```json
{"game":{"action":"move","from":"C:\\Projects\\ExistingGame"}}
```

The key must match the manifest repository ID. Supported actions are `keep`,
`directory`, `init`, `clone`, and `move`; their validity depends on the observed
source/destination and manifest. `directory` creates an empty directory, not a
Git repository. `move` preserves the existing repository, including dirty and
untracked files, and does not change origin. Clone materializes the selected
commit, not uncommitted files of its source.

```powershell
workspace-pipeline wrap --workspace "C:\Work\GameWorkspace" --manifest "C:\Work\workspace.json" --choices "C:\Work\choices.json"
```

Save the exact JSON stdout as UTF-8 `preview.json` outside the affected repository
and wrapper. Read its operations and blockers. Preview may acquire a temporary
Git snapshot, but does not perform repository effects. Remote access is explicit
with `--network`; local Git does not need that flag. Do not put credentials into
source URLs or retained preview files.

```powershell
workspace-pipeline wrap --workspace "C:\Work\GameWorkspace" --apply --preview "C:\Work\preview.json"
```

Apply accepts only the saved preview, not fresh choices or a different manifest.
It rechecks exact inputs and observed filesystem state. A destination collision,
source drift or missing required prepared snapshot causes refusal, not overwrite.
Apply still resolves the manifest's source identity: an unavailable local Git
pipeline source is refused, even when its acquired snapshot is retained. Restore
that source before retrying. Recovery after recorded repository effects instead
uses retained operation inputs, independently of that source and user preview.
Repository clone inputs have their own retained bindings.

`init` uses the same preview/apply shape for a new layout; `adopt` for an existing
one. Inspect `--help` for the installed command surface. Do not treat successful
repository setup as proof that a provider is configured or usable.

## Interruptions and recovery

Do not delete lock directories or replay the original apply blindly. Stdout and
stderr identify operation/journal paths. Retained inputs under
`.pipeline/repository-inputs/` let recovery work without the original user preview
or pipeline source. Preserve these records until recovery and retention checks.

```powershell
workspace-pipeline repositories status --workspace "C:\Work\GameWorkspace"
workspace-pipeline repositories finalize --workspace "C:\Work\GameWorkspace"
workspace-pipeline repositories finalize --workspace "C:\Work\GameWorkspace" --apply --preview "C:\Work\finalize-preview.json"
```

Each mutation requires its own current preview. `status` is read-only;
`no-pending-marker` means no pending marker, not comprehensive workspace health.
Uncertain effects are not silently turned into completed ones. Follow the exact
diagnostics and [recovery contract](repository-recovery.md).

If a stopped process retained operation locks, use the explicit journal UUID from
the operation record, never guess the newest directory:

```powershell
workspace-pipeline repositories recover-locks --workspace "C:\Work\GameWorkspace" --journal "<UUID>"
workspace-pipeline repositories recover-locks --workspace "C:\Work\GameWorkspace" --journal "<UUID>" --apply --preview "C:\Work\locks-preview.json"
```

This can retire attributable locks only after verifying owners, effects and
history. It does not authorize replaying uncertain operations. Bootstrap has
separate `recover-bootstrap`, `continue-bootstrap` and `retire-bootstrap` routes; use only a supported,
verified native preview. Live or unconfirmed owners, torn records and foreign
files must not be removed to force progress.

For the **first** recovery of wrapper creation, retain the original complete
`init`/`adopt` preview (or the native repository preview). This route needs no
pipeline-source access. It supports either a still-absent wrapper with its exact
intent, or an existing wrapper with a matching creation receipt; the recorded
local owner must have stopped. It archives the attributable bootstrap attempt,
not a replay of repository operations.

```powershell
workspace-pipeline repositories recover-bootstrap --workspace "C:\Work\GameWorkspace" --bootstrap-preview "C:\Work\original-init-preview.json"
workspace-pipeline repositories recover-bootstrap --workspace "C:\Work\GameWorkspace" --apply --preview "C:\Work\fresh-bootstrap-recovery.json"
```

Save the first command's full output as the fresh recovery preview for the second
command. The original bootstrap preview and fresh recovery approval are different
files. A stale preview is rejected. If this recovery itself is interrupted, use
`continue-bootstrap` against its retained request instead. Missing/torn original
records or a wrapper without a matching receipt remain blocked; do not fabricate
the original preview or clear a lock to proceed.

## Missing parents and abandoning an uncertain attempt

Missing wrapper ancestors have a separate bounded plan. It creates approved
parents only, not the wrapper or repositories. Afterward prepare a fresh
`init`/`adopt` preview against the new filesystem state.

```powershell
workspace-pipeline repositories prepare-parent --workspace "C:\Work\New\GameWorkspace"
workspace-pipeline repositories prepare-parent --workspace "C:\Work\New\GameWorkspace" --apply --preview "C:\Work\parent-preview.json"
```

After interruption, preserve the original parent preview. Continuation preview
reads it with `--parent-preview`; apply takes the newly saved continuation envelope
with `--preview`. These files are different approvals and cannot be interchanged.

```powershell
workspace-pipeline repositories continue-parent --workspace "C:\Work\New\GameWorkspace" --parent-preview "C:\Work\parent-preview.json"
workspace-pipeline repositories continue-parent --workspace "C:\Work\New\GameWorkspace" --apply --preview "C:\Work\parent-continuation.json"
```

### Nested repository destinations

Paths such as `repos/api` and `repos/documentation` remain valid manifest paths.
One-shot `init` deliberately refuses missing destination parents; it does not
silently widen repository approval into recursive directory creation. Use the
existing bounded parent-preparation route, then obtain a **fresh** `init` preview.

For a new `C:\Work\Services` wrapper, the following parent preview has
`C:\Work\Services\repos\api` as its **sentinel**, not as the actual pipeline
workspace. It proposes creating only the missing chain `Services`, `Services\repos`;
neither `api` nor `documentation` is created by this command. Review the returned
`targets`, `anchor`, and history location before saving and applying its JSON.

```powershell
workspace-pipeline repositories prepare-parent --workspace "C:\Work\Services\repos\api"
workspace-pipeline repositories prepare-parent --workspace "C:\Work\Services\repos\api" --apply --preview "C:\Work\nested-parent-preview.json"
workspace-pipeline init --workspace "C:\Work\Services" --manifest "C:\Work\workspace.json" --choices "C:\Work\choices.json"
```

Save the last command's new complete preview and apply it to `C:\Work\Services`
through the normal `init --apply --preview` route. Do not reuse an `init` preview
from before parent creation. Both sibling repositories can now be created by the
same repository plan. For separate missing branches, prepare each required chain
explicitly and inspect it separately. The manifest/schema/examples are unchanged.

This route also works for an **existing quiescent wrapper**: the parent preview
creates only missing descendants. Stop canonical-workspace CLI writers and agent
sessions first. The parent primitive's lease covers its first missing path, **not
the canonical workspace's writer locks**; it does not certify isolation against
an active `init`, provider mutation, or arbitrary editor in that workspace. Do
not run these operations concurrently. This is an explicit preparation route,
not an automatically guarded one-shot nested bootstrap.

Directory staging records exact per-directory identities before publication and
retains a projection and receipt. If interrupted, use `continue-parent` with the
same sentinel and original parent preview, then approve its fresh continuation.
Unknown/incomplete staging stays blocked for manual review; no blind `mkdir`,
recursive rollback, or automatic deletion is required or authorized. History
may live at an existing ancestor inside the eventual wrapper; preserve it.

If repository effects remain uncertain, explicit abandonment can retain the
failed attempt as history without certifying completion. It preserves partial
repository data; it is not rollback, cleanup, permission to delete data, or a
claim the original operation succeeded. Inspect the entire fresh observation
before applying, then reassess the preserved repositories in a new plan.

```powershell
workspace-pipeline repositories abandon --workspace "C:\Work\GameWorkspace"
workspace-pipeline repositories abandon --workspace "C:\Work\GameWorkspace" --apply --preview "C:\Work\abandon-preview.json"
workspace-pipeline repositories continue-abandon --workspace "C:\Work\GameWorkspace" --attempt "<attempt UUID>"
workspace-pipeline repositories continue-abandon --workspace "C:\Work\GameWorkspace" --attempt "<attempt UUID>" --apply --preview "C:\Work\abandon-continuation.json"
```

The attempt UUID must come from the actual abandonment record. Unknown owners,
changed subjects or unverifiable history still block these commands.

## Corrected control records and recovery boundaries

Full file observations and compact saved records are described in
[repository observations](repository-observations.md). Separate user-repository
clone ceilings are listed in [transport budgets](repository-transport-budgets.md),
including their preview-visible pack/time limits; pipeline-package limits do not
serve as implicit game-repository limits.

Successful layout work reports `repositories-prepared` with
`pipelineActivated:false`; it is not harness or game readiness.
Abandonment refuses a finalizable completed operation: use the exact finalization
route instead. Interrupted abandonment approvals are retained sequentially as
`authorization-NNNN.json`, each bound to previous authorization hashes. Earlier
development histories using UUID approval names are not rewritten or silently
accepted under the new format; preserve them for manual inspection.
First lock recovery now archives the whole gate as `recovery-gate` in its history,
including the owner record, instead of deleting the gate in separate steps.

## Packed regression details

`npm run test:packed` packs and installs the npm tarball offline into a unique
temporary directory. It verifies packaged files, runs the installed entrypoint,
and retains `report.json` plus fixtures at the printed location. The S7 portion
covers init, dirty/untracked wrap, destination collision, unavailable-source apply
refusal, source-independent finalization, uncertain-effect refusal and stopped-lock recovery.

Crash setup uses real exited children and native APIs **from the installed
tarball**, not a hidden public CLI fault flag; recovery uses the public installed
entrypoint. These are synthetic author tests, not independent review, real
provider/runtime validation or permission to migrate a user's workspace.
