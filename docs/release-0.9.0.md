# CLI 0.9.0 — shared OpenSpec planning store

Release preparation; publication is a separate maintainer action.

## Changes

- Optional `integrations.openspec.store` binds participating service repositories
  to one documentation repository with OpenSpec 1.14.1.
- Setup/update manages workspace-local registration and service pointers;
  single-repository declarations remain supported.
- Owned pointers can be repaired/retired, borrowed pointers are preserved.
  Planning documents and durable store identity survive removal.
- Doctor reports repository, path and recovery hints for identity/config drift
  without writing files or disclosing config contents.
- Shared tasks do not grant cross-service implementation authority.

See [manifest and lifecycle details](openspec.md#shared-planning-store-cli-090).
No existing workspace is migrated by this release preparation.

## Verification

Before the metadata-only version bump, the final implementation passed:

- Full regression: exit 0; 1156 tests, 1155 passed, 0 failed, 1 skipped.
- Packed shared-store lifecycle: 7/7 passed using real local OpenSpec.
- Independent doctor review (reported by the reviewer through the user):
  no defects; 41/41 tests and 3/3 exact human-output probes passed.
  A nonblocking coverage gap remains: the committed human-output assertion
  does not explicitly assert the diagnostic code; the independent probe did.
- Synthetic Codex/Claude/Grok discovery/routing, bounded A implementation,
  handoff recovery, refusal of unapproved B work, and separately approved B
  implementation. These are bounded observations, not runtime certification.

The version/docs changes do not modify the tested implementation. The release
workflow must rerun its gates and verify the exact published tarball integrity.
The earlier 0.8.0 test tarball is not the 0.9.0 release artifact.
