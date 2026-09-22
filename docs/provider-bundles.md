# Provider bundles (development)

A bundle installs a declared set of native configurations together. It does not
install the harnesses, log in, translate missing configurations or enable a
native plugin. The initial bundle entry format supports Claude/Grok with a single
full CLAUDE.md. The two harnesses keep separate skill, agent and MCP destinations.

## Pipeline source

Declare components under the existing `providers` map, then name the delivered
set. Every listed member must have its own provider declaration:

```yaml
bundles:
  claude-grok:
    providers: [claude, grok]
    entry:
      source: instructions/CLAUDE.md
      target: CLAUDE.md
```

Only Claude supplied? Use `[claude]`. Only Grok? Use `[grok]`. Both are valid.
There is no full/partial flag: doctor shows the exact supplied/installed set.
An absent provider is not configured merely because it can read CLAUDE.md.
No second GROK.md is generated. The bundle entry is required in either case.

The source entry is an inventory-bound UTF-8 workspace template. Existing
`{{documentation}}` and `{{repository.name}}` substitutions refer to the wrapper
layout. Its deployed Markdown links must be wrapper-relative, not source-folder
relative. Unknown substitutions fail. Full rules and provider-specific sections
are allowed; make those sections explicitly conditional on the current harness.
Skills retain their existing canonical snapshot-relative routing.

One bundle is supported initially because there is one allowed bundle entry
destination. Nested bundles, arbitrary destinations and unknown native renderers
are rejected. Source data cannot introduce executable CLI adapters. Composition
changes among supported providers do not require new package-specific CLI code.

## Workspace selection

Select the bundle, not its individual members. For example, alongside Codex:

```yaml
providers: [codex]
bundles: [claude-grok]
```

The ordinary Git source and layout/profile fields are still required. A workspace
with only a bundle may omit `providers`. Setup/update use the usual saved preview
and explicit apply; the preview includes all supplied members and the entry.
It is not necessary to install both harness executables to configure the bundle.

## Lifecycle

- Update adds or retires members according to the new verified source, with exact
  target changes visible before approval. User-modified owned files block writes.
- Repair restores the installed snapshot and membership, not the latest source.
- Remove the bundle together. Member-only removal is refused with
  `remove.bundle-required`, rather than silently deleting the other harness.
- Existing foreign files are not overwritten. Historical backups are retained
  during a managed migration and restored when their owner is finally removed.
- Old source manifests without bundles retain standalone behavior. To migrate,
  explicitly select the source's bundle and approve the resulting update preview.

Removal preview example (replace path/id):

```powershell
workspace-pipeline remove --workspace "C:\Work\example" --bundles claude-grok
```

Save the complete preview using the existing documented workflow, review it, then
apply with `--apply --preview <absolute-file>`. Apply accepts no changed selectors.
Preview files may contain private configuration bytes; keep them local.

## Runtime is a separate check

Grok's observed loading of root CLAUDE.md is intentionally accommodated. Use the
[scoped launcher](launch.md) for the tested compatibility switches. Full native
entry behavior and suppression of duplicate agents/hooks/plugin MCP are still
not certified. Bundle installation is not a claim of full Claude compatibility,
runtime readiness or approval of a pipeline stage.
