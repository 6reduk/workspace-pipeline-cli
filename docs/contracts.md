# Contract layer (S1)

This is a library layer, not an operational installer. The executable still exposes
only help. No provider is ready. Source acquisition, physical containment and apply
are later stages.

## Reading route

- Portable package: [pipeline schema](../schemas/pipeline.schema.json).
- Portable workspace: [workspace schema](../schemas/workspace.schema.json).
- Shared types: [common schema](../schemas/common.schema.json).
- Package file list: [inventory schema](../schemas/inventory.schema.json).
- Local deployment: [state schema](../schemas/state.schema.json).
- File-operation preview/receipt: [operation schema](../schemas/operation.schema.json).
- Agent coordination: [collaboration](collaboration.md).

The four portable schemas are the reviewed v1 definitions. They do not invoke remote
schema resolution. New local state/operation schemas are implementation subjects for
review; they are not project governance versions.

## Parsing and validation

`parse(text, format)` accepts JSON or YAML 1.2 core representing JSON-domain data.
It rejects duplicate keys (including escaped JSON keys), multiple documents, explicit
tags, anchors/aliases, merge keys, non-string mapping keys, prototype-sensitive keys,
non-finite/unsafe integer numbers, input over 2 MiB, depth over 64 and over 50,000 nodes.
Explicit tags/aliases are deliberately unsupported on both keys and values, not
partially expanded. Node/depth limits count mapping keys as well as values.
Multiple documents produce parse.documents; parser syntax failures produce parse.syntax.
A leading BOM and CRLF are allowed. Callers loading bytes must decode UTF-8 strictly;
this API accepts text, not arbitrary byte buffers.

JSON syntax is first checked with JSON.parse; the YAML AST then checks keys before
conversion. Returned mappings have null prototypes. Errors expose stable codes,
not parser excerpts or source values. These are domain inputs, not a general-purpose
editor for existing harness settings: preserving foreign comments/format is S8/S11.

`validateStructure(kind, value)` uses local Ajv 2020-12 schemas without coercion,
default insertion or field removal. It does not mutate inputs. Strict type-placement
and required-placement lint checks are disabled for the reviewed conditional schemas;
schema validation itself is not disabled.
The common schema is registered for references only: common is not a public
document kind and validateStructure('common', ...) fails with schema.kind.

Implementation references: [YAML document API](https://eemeli.org/yaml/#documents),
[YAML parser options](https://eemeli.org/yaml/#parse-options),
[Ajv JSON Schema](https://ajv.js.org/json-schema.html).
Dependencies are exact-versioned with a lockfile; no package scripts run to parse data.

## Semantic entry points

- `validateBundle(pipeline, workspace, adapters?)`: provider subset/capabilities,
  required-null rejection, explicit layout versus named profile, reference IDs, clone
  subdirectory, custom/default common entry selection and lexical package paths.
  Pipeline-source subdirectory is checked both in bundles and stored snapshots;
  dot means package root, other values follow portable-path rules.
  Omitting adapters checks declarations only, never certifies a harness.
- `validateInventory(inventory, {inventoryPath, manifestPath})`: lowercase SHA-256,
  self-entry, mandatory manifest, path/case collisions, trailing dot/space and cap.
  9,999 entries plus the inventory equals the 10,000-file cap.
- `renderEntry(text, layout)`: only repository.<id> and documentation substitutions;
  unknown or malformed tokens fail, including extra braces adjacent to a token.
  Ordinary single braces (for example JSON around a quoted token) remain literal.
  No expressions are evaluated.
- `resolveEntryChange(...)`: pure ownership decision; foreign content conflicts
  unless explicitly preserved/replaced. A merge must be prepared as a separately
  reviewed desired result. S4/S8 must compute the supplied hashes from actual bytes.

Physical inventory equality, blob hashes and size totals are S2. Repository overlap,
canonical roots, reserved roots, symlink/reparse containment and resolved path budgets
are S3. These checks cannot be replaced by a structural PASS.

## Adapter boundary

`src/providers/interface.js` declares five capabilities, including behavioural
compatibility-isolation (no artificial corresponding file). Non-null components imply
capabilities even if requires omits them. Required null components and empty providers
fail. An adapter has id/version/capabilities plus pure validate/plan methods.

Adapters are trusted CLI modules, never executable modules loaded from the pipeline.
The test double is only a contract fixture and produces no operations. S8/S11 must
verify native provider roots and actual discovery before enabling a real adapter.
Adapters validate their data before proposing operations; they do not perform writes.
Generic planning and ownership checks must inspect proposed operations in S4.

## Local state

State contains canonical workspace, configuration status, independent runtime status,
active deployment or null, and pending plan digest or null. An active deployment
contains pipeline/version, frozen Git identity, snapshot/inventory digests, explicit
layout/providers, adapter versions and ownership records.

Manifest origin retains original absolute path/base/digest and resolved source.
A copied manifest is not a new resolution base. Local snapshot and backup paths live
under .pipeline/snapshots and .pipeline/backups. Rebind detection is S4.

Ownership is per file or JSON Pointer field; file/field and ancestor-field overlap
are rejected. Original existing values require a local backup reference. Hashes and
references are stored instead of secret-bearing before/after values. Backup protection,
actual existence and field serialization are later I/O checks.

Ready requires an active deployment and no pending operation. Not-installed requires
neither. Needs-reconciliation requires a pending plan digest; drift requires an
active deployment. Conflict and unsupported can describe a pre-installation
diagnostic and do not require an active deployment. Pending work never implies a
successful new deployment.

## File plans, receipts and transitions

A plan binds workspace, command, before-state digest, frozen source, desired deployment
and ordered target operations. One target path appears once; field edits are combined
into a containing-file replacement with whole-file before/desired guards.
Create/replace/delete/edit-fields have explicit hash/null rules.

validateOperation(plan, previous?) and validateReceiptForPlan(receipt, plan, previous?)
require previous when beforeStateHash is non-null. The previous state must validate
and match the plan workspace and digest. With a null beforeStateHash, previous must
be omitted or null. validateTransition forwards its previous state to these guards.
Target owners must be shared or belong to the union of previous.active.providers
and desired.providers. This allows removal/restoration of a former provider while
rejecting unrelated owners, without weakening source-state binding.
Provider membership alone is not file-level write authority: S4/S5 still check exact
ownership, permitted targets and observed bytes before any write.

The current operation schema describes file operations only. Clone/move transaction
records needed by init/adopt must be added and tested in S7 before those commands can
be exposed; listing their names does not implement them.

A receipt binds the canonical digest of that exact plan and every ordered target's
ID and before/desired hashes. Status is completed, failed, uncertain or skipped.
Completed requires desired readback; failed requires unchanged before-state. After
the first non-completed operation, all following operations must be skipped.

`contractDigest` sorts object keys, retains array order and hashes UTF-8 JSON with
SHA-256. Use it only on validated JSON-domain data; it is not a general serializer.
Source file digests use exact bytes instead.
Numbers follow JSON serialization: -0 and 0 have the same canonical representation.
This is intentional normalization, not distinct domain identities; current validated
plan/state numeric fields do not depend on signed zero. String values remain distinct.

`validateTransition` checks previous-state digest, workspace identity and full
receipt coverage. Completion selects exactly the planned deployment; failure keeps
the previous active deployment and records needs-reconciliation + pending digest.
All installer transitions reset runtime to not-run. No document approval is touched.

These are consistency guards, not proof of execution or user authorization. S4/S5
must compute hashes from actual state, enforce approved preview and lock, execute
guarded writes, verify readback and persist the journal. A fabricated consistent
receipt is not runtime evidence.
