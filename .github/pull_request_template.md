## What

<!-- One-line summary -->

## Why

<!-- What problem this fixes / what it enables -->

## Test plan

- [ ] `npm test` passes (the 10 `params_hash` preimage regression tests)
- [ ] `npm pack --dry-run` shows 6 files, no `.mcpregistry_*` or `.env*` leakage
- [ ] `node trade-router-mcp.mjs` starts cleanly (advertises 21 tools on `tools/list`)
- [ ] If touching tool definitions: per-tool description still has `WHEN TO USE / WHAT IT DOES / RETURNS / SIDE EFFECTS` structure and per-parameter descriptions

## Versioning

- [ ] CHANGELOG.md entry added at the top
- [ ] `package.json` version bumped (semver)

## Notes for maintainers

<!-- Anything that needs special attention during review. Trust gaps, breaking changes, etc. -->
