# Repository observations and control-record size

Repository files (including ignored and untracked data) are fully inspected under
the repository bounds: 200000 entries, 100 GiB content and depth128. Full entry
lists are transient observations, not embedded into saved command previews or
per-operation evidence. The shared JSON/YAML control parser retains its 2 MiB and
50000-node limits; these are not user-repository file limits.

Saved inventory summaries contain root identity, entry count, byte total, exact
identity-inventory digest and a separate rename-stable content/mode digest.
Committed-tree summaries contain commit, entry count, total bytes and tree digest.
Apply still rebuilds the whole observation from original trusted inputs and
compares the complete compact preview. After effects, native evidence records the
new exact summary; reconciliation rescans current trees and compares it. A digest
alone is neither an execution receipt nor authority to replay missing work.

Historical full-entry evidence remains readable for reconciliation/retention where
it fits the original parser bounds. Saved previews from the earlier development
format are not silently rewritten; take a fresh preview before a new operation.
Interrupted records that cannot be verified remain manual recovery cases.

Filesystem identity uses mtime/ctime, not atime. Concurrent changes may refuse a
preview even when an operator considers the content equivalent. Do not suppress
drift checks to force apply; stop writers and obtain a fresh observation.

Busy/access diagnostics are deliberately distinct: EBUSY is busy, EACCES/EPERM is
access-denied (permissions or sharing policy may be responsible). A read-only
preflight cannot guarantee that a later rename/open will be permitted. Such an
apply failure preserves pending uncertainty and never claims automatic rollback.
