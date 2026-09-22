# Shared entry and local resources (S8)

The trusted shared adapter produces one wrapper `AGENTS.md` for all selected
providers. It does not write into code/documentation repositories or global
harness configuration. An existing foreign entry is still subject to normal
ownership/conflict checks; choosing a template is not permission to overwrite it.

`agentsDocument.mode: default` selects the small CLI entry. `mode: source` reads
the specified file exclusively from the verified Git snapshot. The workspace
selection overrides the pipeline default. The existing bounded substitutions
`{{documentation}}` and `{{repository.ID}}` resolve to wrapper-relative paths;
unknown substitutions fail. No expressions, includes or source code execute.

Both modes append the resolved repository/documentation/project-root map and
the installed resource location. Paths are relative to the wrapper. Pipeline
resources stay at `.pipeline/snapshots/<digest>/<resources>` in the already
verified local snapshot, not in a mutable global cache. A later source move or
network outage does not change this location. The digest is installation metadata,
not a workflow gate or a requirement to update project documentation versions.

Trusted adapter contexts now carry `snapshot` alongside pipeline/workspace/layout
and copied source bytes. Setup, locked preflight, switch and repair provide the
same binding. Adapters must not treat an arbitrary source path as a filesystem
grant. `sourceBytes`/`sourceText` have no filesystem fallback; resource routing
checks the snapshot path against its digest.

New deployments retain the resolved `agentsDocument` selection. Repair can thus
reproduce a custom entry even if the workspace manifest is unavailable. The field
is optional when reading earlier state; absent selection uses the package default,
and repair's existing hash comparison still rejects mismatched reconstruction.
Resources and old snapshots remain subject to the existing retention policy, not
implicit deletion when an entry is removed.

The public registry pairs this shared adapter with Codex/Claude renderers. Native
discovery, packaged lifecycle and independent review are separate S8 checks.
File/config checks do not certify model-visible instructions, trust,
MCP execution or semantic approval.
