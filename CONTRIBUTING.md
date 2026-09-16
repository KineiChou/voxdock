# Contributing

Use a short-lived branch for a cohesive change and open a pull request against
`main`. Commit titles follow `type(scope): summary`. Include the problem, resulting
behavior, relevant checks, and any remaining limitations in the pull request.

The maintainer reviews the diff and validation evidence before merging. We use
squash merges by default and remove merged feature branches.

Update documentation alongside behavior changes. Record significant decisions
and confirmed bug causes with their fixes; keep application-facing documentation
focused on installation, usage, and supported behavior.

Tests should cover contracts, failure boundaries, and important behavior. Real
phone and model checks are opt-in and separate from ordinary CI. A mock passing
does not establish native platform compatibility.
