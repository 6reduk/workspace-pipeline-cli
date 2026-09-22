# Repository recovery when ownership or evidence is incomplete

This is the operator path for states that cannot safely enter a native recovery
writer. An error or an empty lock directory is not evidence that nobody owns the
operation. A missing result record is not evidence that a clone/move did not run.
Nothing in this document authorizes deleting a lock, editing a journal, inventing
an owner record, overwriting a repository, or converting an unknown result to PASS.

## First: preserve and classify, without applying anything

1. Record the exact absolute wrapper and the CLI error code. Keep the original
   preview, operation UUID, reported journal/history locations and console output.
   Do not select an operation by newest timestamp. These records may contain
   private configuration: keep diagnostic copies local and access-restricted.
2. Ask the people/process owners using that workspace to stop relevant installer,
   recovery and repository-writing work through their normal controls. Do not
   kill a PID merely because it appears in an old record: PIDs are reused. A
   foreign hostname or inability to inspect a process leaves liveness unknown.
3. Use the following read-only commands. A nonzero exit/error is useful evidence;
   it does not mean the command repaired anything. Do not append `--apply`.

   ```text
   workspace-pipeline repositories status --workspace <absolute-wrapper>
   workspace-pipeline logs list --workspace <absolute-wrapper>
   ```

   `repositories status` reads a pending operation and its retained inputs when
   available; it reports persistent blockers. `no-pending-marker` does **not**
   certify historical completion or absence of effects. `logs list` may report
   inaccessible/incomplete records rather than parse them. Neither command repairs
   missing records, retires locks or establishes unknown process ownership.
4. Preserve original bytes in place. If an operator makes a diagnostic copy,
   record source paths and hashes, distinguish a copy from the original, and do
   not follow unknown links/reparse points. An inconsistent or changing copy is
   not a stable before-state. Do not publish credentials or whole user configs.
5. Compare with the cases below and select a matching preview-only route. A route
   that rejects the state must not be bypassed by editing the record it rejected.

## Cases and actual native boundaries

| Observed state | Supported next observation/action | Boundary |
| --- | --- | --- |
| Completed repository effects with intact retained input/journal and no ownership blocker | `repositories finalize --workspace <wrapper>` previews exact finalization | Its approved apply only records verified completion; it does not repeat clone/init/move |
| Completed evidenced effects but stopped, attributable locks remain | `repositories recover-locks --workspace <wrapper> --journal <uuid>` | Preview/apply checks exact journal, owner and effects; live/unknown owners remain blocked |
| Wrapper absent; bootstrap lock contains only a complete valid local owner record | `repositories retire-bootstrap --workspace <wrapper>` | Eligible only when that local owner is confirmed stopped; archives the lock, never certifies execution |
| Original bootstrap preview is intact; exact intent with absent wrapper, or matching wrapper creation receipt | `repositories recover-bootstrap --workspace <wrapper> --bootstrap-preview <original-preview.json>` | First recovery only, with a confirmed stopped local owner; creates a fresh recovery preview without source lookup or repository replay |
| Bootstrap recovery gate has a complete retained request and coherent original records | `repositories continue-bootstrap --workspace <wrapper>` | Continues only remaining attributable archival/receipt actions; fresh exact preview approval is required |
| Interrupted repeated paired-lock continuation with intact approval chain | `repositories recover-locks` for the same explicit journal | Requires a fresh observed-state preview; does not reuse an old approval as ownership |
| Pending repository operation with intact inputs, unchanged inventoried trees and attributable stopped locks, but effects not finalizable | `repositories abandon --workspace <wrapper>` | Explicitly preserves current source/destination trees and abandons the operation; does not call partial effects completed or undo them. New repository preview is required |
| Interrupted abandon with intact retained request and guard | `repositories continue-abandon --workspace <wrapper> --attempt <uuid>` | Preview binds the named attempt; apply does not infer a different attempt |
| Parent staging has a complete projection or was published before its receipt | `repositories continue-parent --workspace <wrapper> --parent-preview <original-preview.json>` | Fresh preview may finish the exact projection; foreign additions or identity drift reject continuation |
| Parent staging stopped before a complete projection, with no live-path publication | Preserve that attempt; a fresh `repositories prepare-parent` preview can choose a new staging history | The earlier staging remains untouched. This does not adopt unknown directories or delete remnants |
| Empty bootstrap lock; torn/invalid owner; wrong host or owner liveness unknown | Manual decision required; native owner retirement refuses | An empty record cannot prove a dead owner, even if no process is visible to this shell |
| Recovery gate without a complete request; torn continuation authorization; corrupted input/receipt | Manual decision required; native readers refuse missing/inconsistent bindings | Do not fill gaps using similar neighboring files or remembered chat text |
| Wrapper exists but there is no matching creation receipt, or clone/move effects conflict with retained evidence | Manual decision, or explicit abandon only if its independent eligibility checks pass | Compatible-looking files alone do not prove origin or successful completion |

For each eligible route, save its full preview privately as UTF-8, inspect the
exact operations and blockers, then separately approve the corresponding
`--apply --preview <file>` command. See [native recovery](repository-recovery.md).
Parent continuation retains each fresh approval as `authorization-NNNN.json`
inside its history before remaining actions. Each record binds the exact observed
state and preceding approval hashes; the chain admits at most 64 approvals.
A torn authorization is not rewritten. A completed readback appends nothing.
No route proves that unrelated harness sessions, Unity, Git helpers or other
machines have stopped. Local IPC exclusion is cooperative and not a distributed
or hostile-process safety boundary.

## What an operator decision must establish

A manual decision is a bounded escalation, not a hidden retry loop. Provide:

- Exact affected wrapper, source/destination repositories, journal/attempt ID and
  observed files; identities/hashes where the current observation supports them.
- Who established quiescence, on which host, and which process identities were
  actually checked. Unknown ownership stays explicitly unknown.
- Original preview and independently retained request/receipt/backup, if they
  exist. Identify their source and hashes. A user-supplied copy is evidence to
  evaluate, not permission to replace a missing native record or proof of a
  historical result. Human recollection can guide investigation, not manufacture
  machine provenance.
- Intended disposition: preserve the present repositories and start a new plan,
  or a specific separately reviewed reconciliation/compensation. Enumerate exact
  paths and preservation requirements. No broad cleanup or implicit origin change.
- Remaining uncertainty and how the proposed action avoids touching files whose
  ownership or before-state cannot be established.

There is intentionally no force/unlock recipe here. If native prerequisites cannot
be established, stop and review the exact situation with the workspace owner; an
explicit separately designed recovery may be necessary. A diagnostic report can
close the investigation step while the operation itself remains unresolved. Do
not represent that as successful recovery, installation readiness or S7 runtime
certification.

## Why this is consistent with the execution contract

The execution contract requires reinspection, a fresh preview before continuing or
compensating, ownership-aware compensation, and owner/liveness review for abandoned
locks. It explicitly forbids blind deletion and recursive repository rollback.
It does not require the CLI to reconstruct absent proof or automatically repair
every corrupted record. Partial moves still need a documented disposition:
supported preserve-current-state abandonment is one such route when its bindings
remain intact; genuinely unbound cases retain an explicit operator decision.
