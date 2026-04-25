# Changelog

All notable changes to `@traderouter/trade-router-mcp` are documented here.

## [1.0.10] — 2026-04-25

### Changed
- **`mcpName`** migrated from `io.github.TradeRouter/trade-router-mcp` to `ai.traderouter/trade-router-mcp`. The MCP Registry binds an npm package's ownership to its `mcpName` field, so this enables publishing to the cleaner domain-based namespace via the registry's **DNS-authentication** path. End users are unaffected — the install command (`npx -y @traderouter/trade-router-mcp`) and the npm package name are unchanged.
- **README** `mcp-name:` HTML comment updated to match.

### Why
- DNS-based registry auth on `traderouter.ai` does not require GitHub OAuth device flow, eliminating per-publish friction. The `ai.traderouter/*` namespace also reads more "official" than a GitHub-org-prefixed name and matches our public domain.
- The previous `io.github.TradeRouter/trade-router-mcp` registry entry remains live as a historical record; new releases will publish to `ai.traderouter/*` going forward.

### Operational
- Forever-no-codes setup documented in [`.secrets/dns-auth/README.md`](https://github.com/re-bruce-wayne/openclaw-skills/blob/main/trade-router/SECURITY.md) (in the parent project), driven by `scripts/mcp-publish-dns.sh`.

## [1.0.9] — 2026-04-24

### Added
- **`TRADEROUTER_DRY_RUN` environment variable.** When set to `true`, every write-action tool (`submit_signed_swap`, `auto_swap`, `place_limit_order`, `place_trailing_order`, `place_twap_order`, `place_limit_twap_order`, `place_trailing_twap_order`, `place_limit_trailing_order`, `place_limit_trailing_twap_order`, `cancel_order`, `extend_order`) short-circuits and returns `{ dry_run: true, tool, args, note }` instead of calling the API. Read-only tools (`get_*`, `build_swap`, `list_orders`, `check_order`, `connection_status`, etc.) always execute normally so agents can still explore safely. Defaults to `false` (live mode) for backwards compatibility. Closes the "Mode A has it, Mode B doesn't" gap that SECURITY.md called out in 1.0.8.
- **`test/preimage.test.mjs`** — 10 regression tests pinning the exact `params_hash` preimage shape per order type. Covers the specific drift caught during the 2026-04-24 audit: TWAP/combo order preimages falling back to the 8-field limit shape would silently break signature verification for 6 of the 21 tools. Tests run against `node --test`, no external test framework.
- **`.github/workflows/ci.yml`** — CI on every push and PR. Runs tests across Node 18/20/22, syntax-checks the `.mjs`, dry-packs the tarball, and fails the build if any `.mcpregistry_*` or `.env*` file leaks into it (belt-and-braces on top of the `files:` whitelist).
- **`getOrderCreatedPreimage` and `computeParamsHash` are now exported** from `trade-router-mcp.mjs` so tests can exercise them directly. The main startup is guarded by a `import.meta.url === argv[1]` check so importing the module does not boot the stdio transport.

### Fixed
- None — 1.0.9 is additive only. The `.mjs` preimage code was already correct in 1.0.8; these tests pin that correctness in place.

## [1.0.8] — 2026-04-24

### Added
- **`SECURITY.md`** — complete threat model, data-flow diagram, permissions manifest. Addresses the "suspicious" verdict returned by static analysis tools that cannot infer non-custodial behavior from static bytecode.
- **`LICENSE`** (MIT) shipped in the package (was declared in `package.json` only).
- **`CHANGELOG.md`** — this file.
- **15 npm keywords** for discoverability (`mcp`, `solana`, `trading`, `defi`, `non-custodial`, etc.)
- **`files` whitelist in `package.json`** — prevents accidental inclusion of `.mcpregistry_*` tokens, `.env`, or other stray files in published tarballs.
- **`mcp-name` header in README** for MCP Registry PyPI/npm ownership verification.
- README: LangChain integration snippet using the official `langchain-mcp-adapters`.

### Fixed
- README previously documented `PRIVATE_KEY` env var — the code actually reads `TRADEROUTER_PRIVATE_KEY`. Documentation now matches source.
- README previously claimed `TRADEROUTER_DRY_RUN` and `MAX_DAILY_LOSS_SOL` were supported — neither is in the shipped code. Removed from docs; listed under "What is NOT in this release" in `SECURITY.md`.

### Security
- **Deprecated prior versions that leaked ephemeral publishing tokens in their tarballs:**
  - `@traderouter/trade-router-mcp@1.0.6` and `@1.0.7` shipped `.mcpregistry_github_token` + `.mcpregistry_registry_token` from the `mcp-publisher` CLI's working directory. Both tokens are already invalidated (GitHub OAuth token revoked; registry JWT expired at its 5-minute TTL on 2026-03-12). Upgrade to `@1.0.8` for clean tarballs.
  - This release uses a `files:` whitelist so the same class of leak cannot recur.

## [1.0.7] — 2026-03-12 (superseded by 1.0.8; contains leaked ephemeral tokens — upgrade)

### Added
- TWAP / DCA / combo order preimage functions (`getOrderCreatedPreimage`) supporting 8/10/11-field `params_hash` strings across limit, trailing, TWAP, limit_twap, trailing_twap, limit_trailing, limit_trailing_twap order types.
- Multi-DEX routing across Raydium, PumpSwap, Orca, Meteora.
- `/flex` (trade-card PNG generation) and `/mcap` (market-cap + price lookup) endpoints.
- WebSocket TWAP / DCA orders with configurable intervals.

## [1.0.6] and earlier

See git history at [TradeRouter/trade-router-mcp](https://github.com/TradeRouter/trade-router-mcp).
