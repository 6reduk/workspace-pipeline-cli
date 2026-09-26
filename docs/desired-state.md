# Install and update a workspace pipeline

Development status: these commands require the unreleased 0.7.0 desired-state build,
not the published 0.6.0 package. `workspace-pipeline` below means that build's
installed executable. During development use `node <cli-repository>/src/cli.js`.
Do not run these examples against a real workspace until the migration is reviewed.

## What is installed

A Git repository contains a schema-2 `pipeline.json` (or YAML equivalent). It
declares which files to deliver and which named configuration fields to set or
remove. The CLI does not run scripts from the pipeline source.

The wrapper is an existing directory containing your project repository or
repositories. The CLI configures the wrapper, not the game/application code.
It does not move, clone, initialize or delete project repositories in this route.
Create the directory first and place your repositories where you intend them to live.

## First installation — no prepared JSON file required

Example with a committed local pipeline source:

```powershell
workspace-pipeline setup --workspace "C:\Work\Game" --source "C:\Sources\my-pipeline" --subdirectory pipelines/unity --adapters codex,claude-grok
```

Use actual adapter IDs declared by your source. Unity currently supplies `codex`
and `claude-grok`; the latter delivers Claude files for both harnesses. Kimi is
deferred. Native plugins are not installed by this command.

`--source` also accepts an HTTPS or SSH Git URL. Git authentication remains yours;
never place tokens or passwords in the URL. A relative local source path is resolved
from the shell's current directory, then stored relative to the wrapper. A local
source on another Windows volume is not supported by the current source schema.
Only committed Git contents are used, not uncommitted edits. `--ref` defaults to
`HEAD`, and `--subdirectory` to `.`. Fetching the selected remote source is part of
preparation; no separate network authorization flag is required. Setup, update and reset may fetch the configured remote Git source
before confirmation of workspace changes.

By default the layout is one repository named `game` at `project`, with documentation
at `project/docs`. The displayed summary shows these choices before confirmation.
Override them when the actual structure differs:

```powershell
workspace-pipeline setup --workspace "C:\Work\Game" --source "C:\Sources\my-pipeline" --adapters codex --repository game=game-repo --documentation game=docs
```

For multiple repositories, repeat `--repository` and explicitly bind documentation:

```powershell
workspace-pipeline setup --workspace "C:\Work\Platform" --source "C:\Sources\platform-pipeline" --adapters codex --repository api=services/api --repository docs=knowledge --documentation docs=.
```

Repository and documentation paths are relative and use `/` for separators. IDs
are lookup keys, not inferred project types. Repository paths must not overlap.
The CLI saves the resulting declaration as `workspace.json` only after confirmation.
It is a source/layout configuration, not an execution preview. Existing
`workspace.json` is not overwritten by `setup --source`; use the installed binding
with ordinary `setup`/`update`, or explicitly edit the declaration for a supported
change. Pipeline-ID switching is not implemented in the new engine.

## Update and customization loss

```powershell
workspace-pipeline doctor --workspace "C:\Work\Game"
workspace-pipeline update --workspace "C:\Work\Game"
workspace-pipeline update --workspace "C:\Work\Game" --backup
```

`update` resolves the Git ref saved in `workspace.json`, shows affected paths and
configuration changes, and asks for confirmation. Enter or an answer other than
`y`, `yes`, `д`, `да` cancels. `--yes` authorizes unattended application; noninteractive
use otherwise requires `--preview`. `--json` changes presentation, not authorization.

There is **no backup by default**. A whole-owned directory is replaced with the
declared contents: extra files inside it are removed and modified delivered files
are overwritten. Owned single files are replaced individually. Other directories
are not implicitly owned. Only declared fields of shared JSON/TOML configs change;
credentials, models and unrelated fields are preserved. Obsolete recorded targets
are retired on update. Invalid paths, links, malformed settings and unavailable
sources are errors, not customization conflicts to bypass.

`--backup` saves affected old adapter files/local configuration under
`.pipeline/backups/desired-*`. A requested global backup stays inside the relevant
user profile. Paths are reported. These backups may contain secrets: keep them local.
If requested backup fails, replacement does not proceed.

Global changes are explicitly displayed with their resolved user path and affect
other workspaces. Unity's Claude/Grok adapter sets five user-wide Grok Claude
compatibility flags; it does not change account/model credentials or grant trust.

## Doctor, preview and interrupted work

`doctor` lists extra, modified and missing delivered files, unsafe paths and differing
configuration fields. It displays the recorded Git source, revision and digest.
For Git-bound installations it also reports a missing, invalid or changed
`workspace.json` (source, layout and recorded adapter selection). Repository roots
from the installation and a valid current declaration remain protected. Changing
the declaration is reported as drift, not silently accepted as an installed state.
Older records without adapter IDs cannot verify selection equality; records without
Git binding retain file/config-only inspection.
It does not fetch updates or certify source trust, native skill discovery, MCP or
runtime execution. Version labels do not require rewriting project documentation.

`setup ... --preview --json` and `update ... --preview --json` inspect without applying
or creating the descriptor. In schema 2 this is an observation, **not** a saved-plan
authorization accepted by `--apply`. The old `--apply --preview <file>` route is
retained for schema-1/legacy operations only; a schema-2 replayable-plan route is
not implemented. Normal schema-2 use needs neither external file nor `--apply`.

Replacement is not atomic across all files and has no automatic rollback. After a
failure, inspect the reported partial state and `doctor`. The pending record binds
the same Git revision/digest; retry must use that same source and selection. If a
branch moved, the new revision is refused as a retry; `reset` can reacquire the
recorded commit instead (see below). Do not delete pending records
or locks to force success. For an abandoned lock use the bounded recovery command
below; old legacy recovery commands do not apply to these records.
The schema-2 switch command route is not yet implemented;
legacy commands are not a substitute. These are release limitations, not a claim
that the entire migration is finished.

## Reset to the installed version

```powershell
workspace-pipeline reset --workspace "C:\Work\Game"
workspace-pipeline reset --workspace "C:\Work\Game" --backup
```

The default is the recorded installed Git commit, **not latest**. Reset reacquires
that commit from the saved source and checks its recorded digest before changing
anything. It restores delivered files and named settings and removes extra files
inside owned directories. It uses the same confirmation and optional backup rules
as update. `--preview --json` only displays the proposed effect.

Use `update` to move to the current source ref. Reset leaves `workspace.json`
unchanged, so later updates still follow that ref. If the declaration's source,
adapter selection or layout changed, reset refuses rather than guessing which
mapping to restore. Missing binding/adapter metadata or unavailable historical Git
objects likewise prevents reset before replacement. This is not an offline backup
restore. No project files are reset and no Git checkout/reset is performed.

After a handled installation interruption, reset restores the pending installation's
recorded commit even if its branch moved. It does not cancel an unfinished removal,
erase pending metadata or release a stale lock. Global named settings can be
restored just as during update, with the shared effect displayed before consent.

## Recover an abandoned lock after process termination

```powershell
workspace-pipeline recover-lock --workspace "C:\Work\Game"
# Only when the reported global Grok lock belongs to this workspace:
workspace-pipeline recover-lock --workspace "C:\Work\Game" --global
```

This command does not kill processes, resume installation or modify configuration.
It verifies the lock's purpose/workspace, checks that its PID is absent on the same
host, displays the target and asks for confirmation (`--yes` for unattended use).
`--preview --json` is read-only. A live/reused PID, unknown host, malformed or older
owner format, missing owner, links, foreign entries or a conflicting repository
operation prevent recovery. Lock age alone is never sufficient.

The exact stale directory is renamed to a temporary sibling, its owner identity
is rechecked, and its owner file and directory are deleted nonrecursively. No
lock archive is retained after success. Pending operation records remain intact.
Run doctor and explicitly retry reset (installation) or remove (removal) afterward.
No automatic retry is performed.

Recoverers are serialized using the existing OS lease (Windows/Linux only).
After the atomic rename, recovery never touches the original lock path again:
a new writer may already own it. If deletion fails, the error reports
`lockReleased: true` and `residualPath` for inspection. A process crash after
rename can leave a `*-retiring-<uuid>` sibling; it is not an active lock, and
recovery does not automatically sweep such leftovers or older recovered-lock
archives. No recursive cleanup or archive-retention command is provided.

These are cooperative-process safeguards, not isolation against hostile concurrent
filesystem mutation. Empty/partially written owners and old token-only global locks
need separate inspection, not a force-unlock flag. Source/package corruption and
partially written configuration are not repaired by lock recovery.

## Remove and reinstall

```powershell
workspace-pipeline remove --workspace "C:\Work\Game"
workspace-pipeline update --workspace "C:\Work\Game"
```

`remove` operates offline on the recorded installation, displays its scope and asks
for confirmation (`--yes` for unattended use). It removes the entire delivery,
including custom files in owned directories, and its named local configuration
fields. It does not need the Git source. `--backup` is optional, off by default.
`--preview --json` observes the removal without applying it.

Project repositories, unrelated config fields, `workspace.json`, existing journals
and backups are preserved. Shared user-wide Grok compatibility is deliberately
left unchanged because other workspaces may use it. Remove does not uninstall
native plugins or erase unknown/unrecorded old adapters. It does not support partial
provider selection. Missing/invalid ownership, unsafe paths and malformed shared
configuration cause refusal, not an unrestricted directory wipe.

Doctor then reports `not-installed`. Ordinary `update` or `setup` reinstalls using
the retained source declaration. A handled interruption during removal can be
continued with the same `remove` command; installation/update cannot replace its
unfinished marker. Conversely, finish an interrupted installation before removing
it. After a hard kill, recover abandoned locks first using the separate command.

## For pipeline authors

```json
{
  "schemaVersion": 2,
  "id": "example",
  "version": "1.0.0",
  "files": [{"source": "core", "target": ".example", "kind": "directory"}],
  "adapters": {
    "codex": {
      "providers": ["codex"],
      "files": [{"source": "instructions.md", "target": "AGENTS.md", "kind": "file"}],
      "settings": []
    }
  }
}
```

Top-level files are shared and installed once. Adapter files/settings are selected
by adapter ID; a provider cannot occur twice in a selection. Source directories
must contain committed files; Git does not supply empty directories. Targets cannot
overlap each other, repositories, CLI metadata, `workspace.json`, or whole shared
configuration files. Field declarations use `target`, JSON-pointer `pointer`,
`operation: set|remove` and a value only for `set`.

Supported configuration targets are `codex.workspace` (named agents/MCP),
`claude.workspace` (`enabledMcpjsonServers`), `claude.mcp` (named MCP),
`grok.workspace` (named MCP), and `grok.user` (five Claude compatibility booleans).
They map to CLI-defined paths; sources cannot provide arbitrary home filenames.
Hooks, credentials, model settings and executable installer extensions are outside
this configuration contract. Review delivered MCP commands before trusting a source.

Keep canonical rules in shared files and provider discovery files small. Validate
relative links in the installed layout, not just in the source repository. Test
fresh install, update after custom changes, removed upstream targets, optional
backup, interruption, and doctor using disposable profiles and the packed CLI.
Package checks are not human approval or proof of model behavior.
