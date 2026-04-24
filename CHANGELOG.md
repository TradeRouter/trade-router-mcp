# Changelog

All notable changes to `@traderouter/trade-router-mcp` are documented here.

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
