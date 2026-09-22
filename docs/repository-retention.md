# Repository execution history cleanup

Repository setup records are a separate cleanup domain from configuration journals.
List locations with `workspace-pipeline logs list --workspace <absolute-wrapper>`.
Record contents may contain private paths/configuration; keep previews and receipts
private. Listing never deletes anything.

```text
workspace-pipeline logs clean --repositories --workspace <absolute-wrapper> --max-age-days 30 --keep-last 20 --max-delete 5
workspace-pipeline logs clean --repositories --workspace <absolute-wrapper> --apply --preview <private-saved-preview.json>
```

Numbers above are examples, not defaults. All three limits are required; age OR
count makes an otherwise eligible group a candidate, and `max-delete` caps complete
groups per invocation. Local latest file modification time is the conservative age
anchor, not an invented execution date. A future timestamp protects the group.
The flag is required for both invocations; it cannot be mixed with receipt cleanup
options or policy commands. Existing startup policy remains configuration-journal
policy, not implicit repository cleanup authorization. There is no background job.

Only internally consistent completed transaction groups (journal, inputs,
authorization when present, result evidence and completion records) are eligible.
Referenced, active, pending, uncertain, malformed and current-run records are
protected. The scan checks bounded metadata and retained recovery references,
including escaped JSON UUIDs and hashes; it does not reread current game content
or assume it still equals an old completed operation. Unknown transaction formats
and uninspectable metadata fail closed. A pending configuration transaction also
blocks cleanup. Opaque retained records are reference roots, not deletion targets.

Bootstrap, ancestor, abandonment and lock-recovery histories remain protected
evidence. Repository cleanup receipts are also retained; this command does not
erase its own audit trail or unrelated configuration receipts. Age/count limits
may remain exceeded when records are protected. Inspect protection reasons rather
than deleting locks or inputs to force eligibility.

Apply holds the workspace lock and recovery lease, rechecks the exact selection
and references, records an execution receipt under `.pipeline/repository-cleanup/`,
and removes only listed files and empty group directories. It prints the receipt
path before deletion and reports partial failures. Deletion is not recoverable.
An interrupted cleanup is not auto-replayed: preserve its receipt and inspect the
reported current file/remaining groups before making a new decision.

Current scan bounds: 20,000 metadata entries, 128 MiB total, 8 MiB per file plus
the normal JSON input cap. Bound failures are explicit blockers, never partial
successful scans. No repository/code/assets, provider configs, installed snapshots
or backups are cleanup targets.
