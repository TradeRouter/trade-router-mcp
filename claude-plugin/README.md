# Trade Router — Claude Code plugin

Non-custodial Solana swap & limit-order MCP server for AI agents. One install, 21 tools across multi-DEX routing (Raydium, PumpSwap, Orca, Meteora), Jito MEV-protected execution, and Ed25519-verified server messages.

This is the Claude Code plugin metadata for [`@traderouter/trade-router-mcp`](https://www.npmjs.com/package/@traderouter/trade-router-mcp). The actual server source lives at the repo root — this `claude-plugin/` subdirectory is the entry consumed by [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official).

## What you get

21 tools the LLM can pick by name:

- **Instant swaps**: `build_swap`, `submit_signed_swap`, `auto_swap`
- **Read-only**: `get_wallet_address`, `get_holdings`, `get_mcap`, `get_flex_card`
- **WebSocket lifecycle**: `connect_websocket`, `connection_status`, `get_fill_log`
- **Order placement**: `place_limit_order`, `place_trailing_order`, `place_twap_order`, `place_limit_twap_order`, `place_trailing_twap_order`, `place_limit_trailing_order`, `place_limit_trailing_twap_order`
- **Order management**: `list_orders`, `check_order`, `cancel_order`, `extend_order`

## Required env var

```bash
TRADEROUTER_PRIVATE_KEY=<your-base58-solana-private-key>
```

Use a dedicated trading wallet — see [SECURITY.md](https://traderouter.ai/SECURITY.md) for the full threat model.

## Recommended for first runs

```bash
TRADEROUTER_DRY_RUN=true
```

Every write-action tool (`submit_signed_swap`, `auto_swap`, `place_*_order`, `cancel_order`, `extend_order`) short-circuits and returns `{ dry_run: true, tool, args }` instead of touching mainnet. Read-only tools still execute. You can drive an agent end-to-end without spending a lamport.

## Why this plugin (vs alternatives)

Most Solana MCP servers are single-DEX (Jupiter only). Trade Router routes across Raydium, PumpSwap, Orca, and Meteora — picking per-token by liquidity. Combined with 11 order types including server-side combo orders (limit → trailing → TWAP, all in one signed `params_hash` commitment) and a published threat model with explicit transparency about the build_swap trust gap, this is the most complete and most honest non-custodial Solana trading MCP available.

## Security signals

- VirusTotal v1.0.10 npm tarball: [0/62 detections](https://www.virustotal.com/gui/file/cf3c2d92a7ab514ef7327197a5b4a603ed844ccac8b269b095f9f834bf2b2fd9)
- GitHub Actions CI: green across Node 18/20/22 with tarball-leak guard
- Branch protection on `main` (no force-push, required CI checks)
- npm publish signed (`dist.signatures` populated)
- DNS-auth publishing on MCP Registry (no device codes)

## Links

- Source: <https://github.com/TradeRouter/trade-router-mcp> (MIT)
- npm: <https://www.npmjs.com/package/@traderouter/trade-router-mcp>
- PyPI (Python equivalent): <https://pypi.org/project/traderouter-mcp/>
- MCP Registry: `ai.traderouter/trade-router-mcp@1.0.12` (`isLatest: true`)
- Cookbook (7 example agents): <https://github.com/TradeRouter/cookbook>
- Glama listing: <https://glama.ai/mcp/servers/TradeRouter/trade-router-mcp>
- API docs + OpenAPI spec: <https://traderouter.ai>

## License

MIT.
