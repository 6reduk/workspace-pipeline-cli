# Git pipeline sources (library and CLI)

The installer reads committed pipeline bytes, not working-tree changes. Local
refs are interpreted in isolated preparation storage; final snapshots contain
independent files. Source repositories, their refs/index/config and user credentials
are not modified. No checkout, smudge filter, automatic history fallback or pipeline
script execution is performed.

## Remote commit pins

A full lowercase commit ID is a valid source selector, but the remote server must
permit fetching that object. Some servers reject a SHA that is not an advertised
branch/tag tip, even if it is an ancestor of a visible branch. This is a server
capability/access boundary, not permission to choose a different commit.

`source.unadvertised-commit` means Git emitted the recognized refusal to request an
unadvertised object. Use an advertised branch/tag pointing to the intended commit,
a local repository containing that commit, or ask the repository administrator
about the server policy. The installer does not change server settings, retry with
full history, or silently substitute the latest revision.

Unknown/localized server errors, connection and authorization failures remain
`source.git-failed`; they must not be diagnosed as an unadvertised-commit refusal
without the specific diagnostic. Raw Git stderr is never returned. Both successful
tip pins and permitted non-tip pins remain supported. Live host/account behavior
is separate from synthetic transport tests.

## Errors and local recovery metadata

- `source.missing-repository`: local source realpath failed with ENOENT.
- `source.repository-unavailable`: another local source resolution failure.
- `source.io` / `snapshot.io`: other unclassified preparation I/O failure, without
  embedding raw filesystem error messages or the source path.
- After creation, failures expose `error.preparation` and/or `error.snapshotPath`
  as exact generated temporary roots. A root not yet created has no such field.
  These paths are machine-local recovery metadata, not portable manifests; keep
  them out of shared/public diagnostics. They do not authorize recursive deletion
  without ownership and current path checks. No automatic cleanup is performed.
- `source.termination-unconfirmed` preserves the owned root `processId` and does
  not claim all descendants stopped. Do not retry or activate the result; inspect
  process identity before later cleanup because a PID may have been reused.

256 MiB is a stop/reject threshold on fetched object storage, not a disk quota.
Transient overshoot between measurements is possible; oversized results are never
returned for installation. Raw file, inventory, manifest and path limits also apply.

The optional fourth `runGit` argument is a trusted code-only runtime seam used by
unit tests to simulate process-control failures. It is not manifest configuration
and must not be populated from pipeline/user data. Tests use simulated processes
for kill-failure branches, avoiding real unkillable helpers.
