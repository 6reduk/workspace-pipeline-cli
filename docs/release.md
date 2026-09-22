# Release procedure

This package is @6reduk/workspace-pipeline, separate from the legacy unity-sdd
installer. Node.js 22+ is required. No native plugin installation is used.

1. Review the exact public source, bump package.json and package-lock.json
   together, run targeted tests and the packed provider lifecycle.
2. Commit/push the approved source. Dispatch release.yml on main. It runs the
   full test suite and packed provider lifecycle, then uploads a tarball.
3. First publication requires the maintainer's normal npm authentication/2FA.
   Download the successful workflow's artifact; publish that exact tarball:
   `npm publish <tarball> --access public --provenance=false`.
4. Once the package exists, configure npm trusted publishing for GitHub repository
   6reduk/workspace-pipeline-cli, workflow release.yml, environment npm-release.
   No npm token belongs in source. Set repository variable NPM_PUBLISH_ENABLED=true
   only after trust is established. Subsequent explicit workflow dispatches can
   publish through OIDC. Existing version bytes must match; never overwrite tags
   or republish different bytes under the same version.
5. Verify registry version/integrity against the uploaded tarball. A successful
   build or uploaded artifact alone is not publication success.

Release workflow does not move a workspace, grant trust or upgrade installed
pipeline snapshots. Publish a pipeline's Git source separately, then use the
ordinary reviewed setup/update preview for each workspace. Kimi native behavior
remains deferred; scoped Grok launch and import-surface limits remain applicable.
