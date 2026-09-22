# Scoped Grok launch (S11 development)

This command starts Grok from an already configured workspace with five Claude
compatibility switches set to false in the child environment: skills, rules, agents,
MCP and hooks. It does not install a pipeline. Configure Grok using the ordinary
manifest-driven setup preview/apply first; do not manually construct state.

Preview first (replace both absolute paths):

```powershell
workspace-pipeline launch grok --workspace "C:\Work\example" --executable "C:\Tools\grok.exe"
```

The default is read-only: it checks installation state and reports the intended
launch without starting Grok. Add `--execute` to start an interactive session.
An interactive terminal is required. For native diagnostic output, use
`--inspect --execute`; this passes only `inspect --json` to the executable.
Diagnostic success does not establish model-visible skills or task readiness.

## Boundaries

- Supply a trusted, absolute native executable path. Windows requires `.exe`;
  `.cmd`/`.bat` wrappers are not accepted. No shell or automatic PATH lookup is used.
- Arbitrary harness arguments are rejected. In particular, the command does not
  forward working-directory, worktree, model, prompt or approval overrides.
- The existing account/profile environment is inherited. Only the five Claude
  pipeline compatibility variables are replaced; parent variables and global
  configuration files are unchanged. Environment secrets are not printed.
- Installation must be ready, include Grok and have no pending operation.
  State is checked around inspection and again immediately before execution.
- Close pipeline configuration editors/updaters during launch. These checks do
  not hold a lock for the session or prevent subsequent concurrent edits.
- This is not a sandbox or executable authenticity check. The selected program
  runs with the user's permissions and can start configured MCP servers. Normal
  workspace trust and action approvals remain the harness/user's responsibility.
- Native plugins and generic skill discovery are not disabled. Removing Grok's
  owned files alone does not prove it cannot discover another provider's skills.
- Native 1.0.40 inspection verified disabled markers for Claude skills, rules and
  ordinary MCP declarations. Claude agents, hooks and plugin MCP remained listed
  without disabled markers. This does not prove execution, but complete runtime
  suppression of those components is NOT_VERIFIED; five environment values are
  not by themselves an isolation guarantee.
- Root CLAUDE.md remained visible in the tested scoped session. Bundled delivery
  uses it intentionally as a full shared entry with conditional provider sections.
  Standalone legacy delivery retains the neutral AGENTS.md route.
  This does not certify other import surfaces or
  the full interactive TUI launch path.

The child exit code is propagated (signals map to a nonzero exit). No pipeline
stage, human acceptance or runtime certification is inferred from that code.
