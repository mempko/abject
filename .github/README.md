# .github/ - GitHub Configuration

GitHub-specific files for the repository. It holds only the Actions
workflows; there are no issue templates, code owners or Dependabot settings.

## Files

- **workflows/release.yml**: builds and publishes a release when a `v*` tag is
  pushed: the desktop app on three operating systems, the headless edition on
  five targets, and a multi-architecture container image on GHCR. See
  [workflows/README.md](workflows/README.md).

## Related

- [workflows/README.md](workflows/README.md): the release workflow, job by job
- [scripts/README.md](../scripts/README.md): `release.mjs`, which pushes the tag
