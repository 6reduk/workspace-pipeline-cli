# Move a workspace manifest or change its source binding

The installer remembers the location of your workspace manifest and the repository
it resolves to. Editing its selected Git ref in place is an ordinary update.
Moving the file or changing its repository needs explicit rebind approval.
This is installation metadata, not a version requirement for project documents.

## Three steps

Prepare the new manifest yourself, preferably as `workspace.json` in the wrapper.
Keep the old file until the update succeeds. Relative local Git paths are resolved
from the **new manifest's directory**, not from the shell or the wrapper.

The following PowerShell example uses illustrative absolute paths; replace them.
Use a private directory for preview files: they can contain configuration values.

```powershell
workspace-pipeline rebind --workspace 'C:\Work\Game' --manifest 'C:\Work\Game\workspace.json' > 'C:\Private\rebind.json'
workspace-pipeline update --workspace 'C:\Work\Game' --accept-rebind 'C:\Private\rebind.json' > 'C:\Private\update.json'
workspace-pipeline update --workspace 'C:\Work\Game' --apply --preview 'C:\Private\update.json'
workspace-pipeline doctor --workspace 'C:\Work\Game'
```

Check the exit status after each command. Never apply an empty or failed preview.
Between the first and second commands inspect `previousOrigin`, `proposed.origin`
and `proposed.manifest`. The first command only reads local state/history and the
new manifest. It does not fetch Git, move files, or activate the new origin.

`--accept-rebind` explicitly approves the saved proposal for source acquisition.
For a remote source, add `--network` to this second command. Inspect the resulting
update operations before the third command, which separately approves file writes.
The new origin becomes active as part of that normal, locked update, not as a
standalone write to `.pipeline/state.json`.

## Boundaries and failures

- Rebind requires an installed workspace without pending operations or broken history.
- Moving the workspace itself is not supported by this command.
- A changed state or manifest invalidates the proposal: regenerate and review it.
- `--accept-rebind` is update-preview-only; do not combine it with `--manifest`,
  `--apply`, or another lifecycle command. Apply uses the saved update preview only.
- Rebind does not approve conflicts with user-edited files, credentials, MCP execution,
  trust grants, cleanup or deletion of the old manifest.
- `repair` still uses the installed snapshot, not a newer Git revision.
- A failed/interrupted apply may have partial effects. Inspect its reported recovery
  record and doctor; do not edit state manually or blindly repeat the update.

Availability: introduced in 0.3.0; these commands are not present in 0.2.0.
