# Contributing to `@traderouter/trade-router-mcp`

Thanks for considering a contribution. This is a non-custodial Solana trading MCP server — we hold a high security and quality bar because the code touches real wallets.

## Quick links

- **Bug?** Use the [Bug Report issue template](.github/ISSUE_TEMPLATE/bug.yml).
- **Feature request?** Use the [Feature Request template](.github/ISSUE_TEMPLATE/feature.yml).
- **Security issue?** Email `security@traderouter.ai` first — do NOT open a public issue. See [SECURITY.md](./SECURITY.md).
- **Pull request?** Read this file, then open against `main`. PRs are gated on CI (Node 18/20/22) and the tarball-leak guard.

## Development setup

```bash
git clone https://github.com/TradeRouter/trade-router-mcp.git
cd trade-router-mcp
npm install
npm test                              # runs the 10 preimage regression tests
node trade-router-mcp.mjs             # spawns the MCP server (stdio); needs TRADEROUTER_PRIVATE_KEY for write tools
```

For safe iteration without touching mainnet:

```bash
export TRADEROUTER_DRY_RUN=true
node trade-router-mcp.mjs
```

Every write-action tool (`submit_signed_swap`, `auto_swap`, `place_*_order`, `cancel_order`, `extend_order`) will short-circuit and return `{ dry_run: true, tool, args }` instead of calling the API. Read-only tools still execute against mainnet (or the RPC you configure via `SOLANA_RPC_URL`).

## What we'll merge

- **Bug fixes** with a regression test that fails before the fix and passes after.
- **New tool definitions** for endpoints we already wrap, with full Purpose/Usage/Behavioral/Parameter description text matching the rest of the TOOLS array.
- **Documentation** improvements — typos, broken links, added examples in the cookbook.
- **CI improvements** — additional checks against the published tarball.

## What we'll push back on

- **Tool description shortenings.** Per Glama's TDQS scoring (avg + min), short descriptions tank the server-level score. New tools need to match the established structure.
- **Custom crypto.** All signing uses `@solana/web3.js` `Keypair.fromSecretKey()` + `tweetnacl`. All hashing uses Node's built-in `createHash`. We do not roll our own.
- **Removing `additionalProperties: false`** from any input schema. Closed schemas catch typos at the agent layer instead of silently passing wrong field names through to the API.
- **Adding new `process.env.*` reads** without first updating SECURITY.md's permissions manifest and the env-var table in the npm README.
- **Breaking changes to `params_hash` preimage shapes.** The 10 regression tests in `test/preimage.test.mjs` exist specifically to prevent silent drift. Any change to a preimage shape requires both server-side coordination and a major-version bump.

## Release process (for maintainers)

1. Update `CHANGELOG.md` at the top
2. Bump `package.json` `version`
3. Run `npm test` — must pass
4. `npm pack --dry-run` — must show 6 files, no `.mcpregistry_*` or `.env*` leakage
5. `git commit -m "vX.Y.Z: <summary>"` and `git push origin main` — CI must go green
6. `npm publish --access public`
7. Update the matching MCP Registry entry: edit `server.json` version, then `~/Documents/TradeRouter/openclaw/scripts/mcp-publish-dns.sh server.json` (DNS auth — no device codes)
8. Bump the Dockerfile pin to the new version (separate commit) so Glama re-introspects against current

## Code of conduct

Be kind. We assume good faith on first contact. Repeated bad-faith behavior gets a ban.

## License

By contributing you agree your contributions are licensed under MIT (matching the repo).
