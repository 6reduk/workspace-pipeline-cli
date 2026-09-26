# Workspace Pipeline CLI

## Desired-state installation (0.7.0 release candidate)

The working tree adds manifest schema 2: ordinary `setup --source ... --adapters ...`
creates `workspace.json` after confirmation; `update` uses it without a separate
preview file. Whole-owned adapter contents are replaced, including custom files;
backups are opt-in with `--backup`. Shared configurations change only declared fields.
See [setup, update, doctor and source authoring](docs/desired-state.md).
This is not in the published 0.6.0 package. The sections below describe the legacy
release and explicit recovery routes; do not mix their backup/preview contracts
with schema 2.

## Published legacy lifecycle

Everyday update: `workspace-pipeline update --workspace <directory>` shows the
changes and asks for confirmation. Use `--yes` for unattended application or
`--preview --json` to retain the advanced saved-plan workflow. See
[update modes](docs/lifecycle-cli.md#everyday-update-executable).

Claude/Grok shared delivery: [one Claude configuration, plain Grok launch,
global compatibility preview and recovery](docs/claude-grok.md).

`@6reduk/workspace-pipeline` — workspace-local pipeline delivery. Licensed under MIT.

**`--help`, read-only `doctor`, and `logs list/clean/policy` are implemented.**
Setup/update/repair/remove/switch/continue use compiled workspace-local adapters
for Codex, Claude, Kimi and legacy native Grok. No native plugin installation
is performed. Claude-only delivery additionally offers an explicitly approved
user-wide Grok compatibility prerequisite. Claude/Grok shared-entry and skill routing were
observed in disposable sessions. Kimi native verification is deferred; its
configuration renderer remains experimental. Real-project migration requires an
explicit preview and approval; installation is not blanket runtime certification.

Version 0.3.0 adds [rebind](docs/rebind.md) (explicit
manifest/source binding changes) and [reset](docs/reset.md) (backed-up restoration
or clearing of selected local adapter configuration). Both require a separate
preview and explicit apply for changes; these commands are not in registry 0.2.0.

Legacy native Grok's Claude-import suppression uses the [scoped launch command](docs/launch.md).
New Claude-only delivery uses plain `grok` and deliberately enables those imports.
File installation does not establish native session discovery or runtime isolation;
Kimi/Grok checks and known generic-skill discovery limits are documented in
[native component formats](docs/native-provider-format.md).
Claude/Grok can be supplied as a single [provider bundle](docs/provider-bundles.md):
separate native configurations, one full CLAUDE.md, and joint lifecycle. A source
may supply either member or both; the CLI never invents missing configurations.

## Purpose

Configure a workspace using a standalone pipeline from a local or remote Git
repository's committed tree. Pipeline packages contain shared rules and provider
skills, agents, MCP declarations and entry instructions; no native plugin lifecycle
is required.

The CLI supports single-repository and multi-repository layouts with an
explicit documentation location. Each workspace owns its installed resources.
Package versions describe installation state, not the validity of project documents.

Provider discovery, isolation, model behavior and live MCP remain distinct checks;
successful file installation does not certify runtime behavior or task approval.

## Development

Requires Node.js 22 or newer and npm. The contract layer uses locked Ajv and YAML
dependencies. See [contracts](docs/contracts.md) and [collaboration](docs/collaboration.md).

```sh
npm ci --ignore-scripts
npm run check
npm test
node src/cli.js --help
node src/cli.js doctor --workspace /absolute/path/to/workspace --json
npm run pack:check
npm run test:packed:providers
```

The executable name is `workspace-pipeline`. Output is readable by default;
add `--json` for complete machine output. Use `--json` when saving any preview
for a later apply, even when redirecting stdout to a file. Doctor exit 0 means
observed configuration ready, 1 means not ready/incomplete, 2 means invocation or
transport error. Unsupported commands exit with code 2. On Windows use an absolute
path such as `C:\Projects\my-workspace`. See [doctor](docs/doctor.md) for limits.

For journal listing and explicit cleanup, see [retention](docs/retention.md).
Cleanup requires a saved, reviewed preview and a separate `--apply --preview`
invocation. It never deletes snapshots, backups, project files or provider configs.
Startup cleanup is disabled unless the user enables a local policy via
`logs policy set`; no numeric defaults are assumed. Internal setup/update honors
that policy; public setup/update uses the same coordinator. Policy commands only
write `.pipeline/retention.json`, never harness settings or project documents.
Repository init/adopt previews acquire the explicitly selected Git pipeline source;
remote acquisition follows the selected source without an extra flag. No command launches MCP or changes
credentials. Repository setup and provider activation are separate steps.
See [repository commands](docs/repositories.md), [recovery](docs/repository-recovery.md)
and [manual recovery boundaries](docs/repository-manual-recovery.md).
See [lifecycle CLI](docs/lifecycle-cli.md) for preview/apply and continuation
contracts, including current restrictions and private-preview handling.

## Distribution boundary

The npm allowlist contains `src/`, `schemas/` and `docs/`, plus npm's standard package metadata,
README and license. Customer manifests, private pipeline definitions and credentials
do not belong in this repository or the published package.

Verification CI does not publish. The separately dispatched release workflow
builds a tested tarball; npm publication remains gated until bootstrap and trusted
publishing are configured. See [release procedure](docs/release.md).
