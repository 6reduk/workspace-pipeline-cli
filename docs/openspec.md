# OpenSpec integration

This optional schema-2 capability requires CLI 0.8.0 or later; CLI 0.7.0 does not support it.
It does not migrate existing Unity changes or replace the current Unity source.

## Pipeline declaration

Add to `pipeline.json`, alongside the existing adapters:

```json
"integrations": {
  "openspec": { "version": "1.14.1", "repository": "game" }
}
```

`repository` is an ID in the workspace layout. It must already exist locally.
Only the tested version 1.14.1 is currently supported. This is an installation
dependency version, not a requirement to reapprove project documents on upgrades.
No arbitrary package names, commands, install hooks or source-provided scripts
are accepted. Older CLI versions reject this declaration; upgrade the CLI first.

Selected providers determine the integration: Codex uses `.agents/skills`,
Claude/Grok uses `.claude/skills`. Both can be selected. Grok compatibility
settings remain the adapter's responsibility; Kimi is not supported here.
The upstream **core**, **skills-only** profile provides six workflows. Custom
global OpenSpec preferences do not select a different project delivery.

Do not also map the same OpenSpec skill directories or their parent directory
from adapter files. Each generated directory has one owner. Map unrelated
custom skills individually rather than owning all `.agents/skills` or `.claude/skills`.
Pre-existing unowned OpenSpec skills cause an explicit conflict, not silent adoption.

## One setup, two layers

The normal `setup` command installs our files and a private OpenSpec npm dependency,
then generates upstream skills in a staging directory and transfers them unchanged
to the wrapper. It does not globally install OpenSpec or require a harness launcher.
`--preview` does not run npm/OpenSpec. Actual setup/update requires access to the
public npm registry; install scripts are disabled. Existing npm cache can be reused.

Runtime lives under `.pipeline/openspec/`: dependency, dependency lock, isolated
generator preferences, generation staging, installation metadata and routing guide.
These are tooling state, not change artifacts, specifications or archive content.
The target repository gets `openspec/specs`, `openspec/changes` and an initial
`openspec/config.yaml` only when missing. Existing documents/config are preserved.

Pipeline authors must route their AGENTS.md/CLAUDE.md or coordinator to
`.pipeline/openspec/README.md`. That generated guide specifies the actual repository
cwd and local invocation, for example from `project/`:

```powershell
npm exec --prefix "../.pipeline/openspec/tool" --offline -- openspec list --json
```

For the command process only, use the guide's XDG_CONFIG_HOME/XDG_DATA_HOME and
disable telemetry/update checks as described there. Do not edit generated skills,
modify persistent PATH, or create another OpenSpec root in the wrapper.
Native skill selection and permissions remain harness behavior, not a doctor guarantee.

## Update, diagnosis, removal

- `update` and `reset` regenerate skills and rebuild the private npm runtime using
  its saved dependency lock. User edits inside owned skill directories are replaced.
  `--backup` saves those skill files before replacement; backups are off by default.
  Runtime cache is replaceable; it is not backed up as project knowledge.
- `doctor` reports the OpenSpec version, incomplete installation, missing/modified
  generated files and extra files within owned skill directories. It checks package
  metadata/lock, not every transitive runtime byte and not model/MCP execution.
- `remove` removes owned skill directories and private npm runtime, retaining
  project specs, changes, project config, unrelated skills and global settings.
  Removing the declaration on update also removes its managed integration.
- A failed install leaves the normal pending operation and OpenSpec incomplete
  state. Repeat the same operation/source after resolving the error. Do not delete
  internal state to manufacture READY; use existing recovery instructions if a
  process died while holding the workspace lock.

The saved dependency lock is installer metadata, not a customization surface.
Unexpected modification is reported, not trusted as a new executable dependency.
Removal retains a small removed-state record, not the dependency lock or npm package.
Planning remains in the project Git repository; nothing is automatically promoted,
archived, committed, published, or accepted.

### Recovery when removal is blocked

Do not delete `.pipeline/openspec/installation.json` to repair an installation.
The npm runtime is replaceable, but that record identifies the owned skills.
If it is missing and skills remain, removal or dropping the integration refuses
with `openspec.removal-residue` instead of claiming success. Doctor also lists
residual skills for a recorded removed installation. No ownership is inferred
from a skill name and no such residue is automatically deleted.

Restore the original installation metadata from your own backup if available.
Otherwise inspect the fixed `openspec-*` directories under `.agents/skills` and
`.claude/skills` (and `.agents/skills/.openspec-target`), move only confirmed
OpenSpec delivery outside those discovery paths, and repeat the operation.
Keep unrelated skills and the project's `openspec/` directory untouched.
For `openspec.foreign-runtime` or invalid metadata, inspect and move the private
`.pipeline/openspec` directory aside after inspecting the skill directories;
do not manufacture an ownership record. Unsafe links require manual inspection
and removal of the link itself, never recursive deletion of its destination.

With `--backup`, the top-level `backupDirectory` reports the skill backup when
there is no adapter backup. If both exist, the adapter backup is at that field
and the second path is `openspec.backupDirectory`; both appear in human output.
Retain both directories if keeping an external backup.

Tool commands have a 180-second timeout; npm requests have a 30-second fetch
timeout. A slow network can leave a retryable incomplete installation. Failures
report phase, exit code and an allowlisted npm/network reason when recognized.
Raw stderr is deliberately not printed: inherited environment and remote errors
can contain credentials even with isolated npm config. An unrecognized cause is
reported as `unclassified`, not guessed.

## Verification

`node --test test/openspec-integration.test.js` tests lifecycle with a simulated
subprocess boundary and no npm network or harness execution. Release verification
must also exercise real npm/OpenSpec with an isolated Git source and workspace,
including preview/setup/update/doctor/remove and protected planning files.
Do not equate subprocess simulation with native/model-visible certification.
