# Repository clone transport budgets

S7 repository acquisition is separate from S2 pipeline-package acquisition. Every
local and remote clone preview binds `packLimit`, `gitMs`, and `acquisitionMs`.
Current defaults and upper ceilings are 100 GiB of stored Git objects, 30 minutes
per Git command, and two hours for each acquisition/materialization Git sequence.
Smaller internal budgets are validated and bound in the same preview. They cannot
be increased during apply without a fresh preview. These are ceilings, not disk
reservations, download-size predictions, throughput guarantees, or total-workspace
execution deadlines. A remote preparation and subsequent local materialization
are distinct sequences and each can retain its object store after failure.

The live object monitor and final size check enforce the pack budget, with possible
monitor-interval overshoot. Timeout termination remains owned-process-only and an
unconfirmed termination remains an error. No retry or full-history fallback is
added. Source records and repository output are retained for explicit recovery.

Committed-tree listing has a separate 256 MiB bounded output allowance, followed
by the existing 200,000-entry and 100 GiB content checks. This does not permit
unbounded buffering or weaken path, Git mode, LFS, filter, or inventory checks.
Tests at/over transport ceilings use numeric boundaries and synthetic subprocess
results; they do not claim a real 100 GiB download or two-hour runtime exercise.

S2 remains 256 MiB stored objects, 120 seconds per Git command, 300 seconds total
acquisition, and its original package blob/tree/output limits. Supplying repository
budgets to the S2 runner does not enable the S7 transport profile.
