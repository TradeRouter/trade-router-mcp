# @traderouter/trade-router-mcp

<!-- mcp-name: ai.traderouter/trade-router-mcp -->

A [Model Context Protocol](https://modelcontextprotocol.io) server for [TradeRouter.ai](https://traderouter.ai) — non-custodial Solana swap, limit, trailing, DCA, TWAP, and combo-order engine for AI agents.

[![Security: non-custodial](https://img.shields.io/badge/Security-Non%20Custodial-green.svg)](./SECURITY.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@traderouter/trade-router-mcp.svg)](https://www.npmjs.com/package/@traderouter/trade-router-mcp)

## Is this safe?

**Yes, and here's exactly why.** The private key is read once from `TRADEROUTER_PRIVATE_KEY`, used for local signing with `@solana/web3.js` + `tweetnacl`, and never transmitted, logged, or persisted. Only signed transactions leave your machine. Server messages are Ed25519-verified against a hard-coded trust anchor. See [SECURITY.md](./SECURITY.md) for the full threat model, data-flow diagram, and permissions manifest.

**Signing flow:**

1. Agent calls `build_swap` → MCP sends wallet *address* (public key) to api.traderouter.ai
2. API returns an **unsigned** transaction
3. **MCP signs the tx locally** using `TRADEROUTER_PRIVATE_KEY`
4. The *signed* transaction is submitted to `/protect` (Jito MEV-protected bundle)
5. Server confirms and returns balance changes. The private key never crosses the network.

## Requirements

- Node.js ≥ 18
- A Solana wallet private key in base58 format (use a dedicated trading wallet, not your main holdings)

## Install

```bash
npx -y @traderouter/trade-router-mcp
```

Or wire it into an MCP client (Claude Desktop, Cursor, Cline, etc.):

```json
{
  "mcpServers": {
    "traderouter": {
      "command": "npx",
      "args": ["-y", "@traderouter/trade-router-mcp"],
      "env": {
        "TRADEROUTER_PRIVATE_KEY": "your_base58_private_key"
      }
    }
  }
}
```

| OS      | Claude Desktop config path                                          |
|---------|---------------------------------------------------------------------|
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json`   |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                       |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                       |

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TRADEROUTER_PRIVATE_KEY` | ✅ | — | Solana wallet private key (base58). Local use only. |
| `SOLANA_RPC_URL` | ❌ | `https://api.mainnet-beta.solana.com` | Custom RPC for reads |
| `TRADEROUTER_SERVER_PUBKEY` | ❌ | baked-in trust anchor | Override the server's Ed25519 trust anchor |
| `TRADEROUTER_SERVER_PUBKEY_NEXT` | ❌ | *(unset)* | Accept messages signed by this key in addition to the primary (key rotation) |
| `TRADEROUTER_REQUIRE_SERVER_SIGNATURE` | ❌ | `true` | Verify server signatures on `order_filled` / `twap_execution` |
| `TRADEROUTER_REQUIRE_ORDER_CREATED_SIGNATURE` | ❌ | `true` | Verify server signatures on `order_created` |
| `TRADEROUTER_DRY_RUN` | ❌ | `false` | When `true`, every write-action tool (`submit_signed_swap`, `auto_swap`, `place_*_order`, `cancel_order`, `extend_order`) returns `{ dry_run: true, tool, args }` instead of calling the API. Read-only tools execute normally. Added in 1.0.9. |

## Tools

| Tool | Purpose |
|---|---|
| `get_wallet_address` | Get the configured wallet's public address |
| `build_swap` | Build an unsigned swap transaction |
| `submit_signed_swap` | Submit a manually signed transaction |
| `auto_swap` | Build + sign + submit in one call |
| `get_holdings` | Get token holdings for a wallet |
| `get_mcap` | Market cap and price for a token |
| `get_flex_card` | Trade card PNG URL for wallet + token |
| `place_limit_order` | Limit buy/sell by price or market cap |
| `place_trailing_order` | Trailing stop buy/sell |
| `place_twap_order` | TWAP (time-weighted) buy/sell |
| `place_limit_twap_order` | Limit trigger → TWAP execution |
| `place_trailing_twap_order` | Trailing trigger → TWAP execution |
| `place_limit_trailing_order` | Limit trigger → trailing execution (single swap on trigger) |
| `place_limit_trailing_twap_order` | Limit trigger → trailing trigger → TWAP execution |
| `list_orders` | List active orders for a wallet |
| `check_order` | Get status of a specific order |
| `cancel_order` | Cancel an active order |
| `extend_order` | Extend an order's expiry |
| `connect_websocket` | Register a wallet over the persistent WebSocket |
| `connection_status` | Current WebSocket connection state |
| `get_fill_log` | Log of filled orders |

## REST endpoints (under the hood)

| Endpoint | Purpose |
|---|---|
| `POST /swap` | Build unsigned swap (multi-DEX: Raydium, PumpSwap, Orca, Meteora) |
| `POST /protect` | Submit signed tx via Jito bundle — MEV-protected |
| `POST /holdings` | Wallet scan — catches tokens standard RPC misses |
| `GET /mcap` | Market cap + price |
| `GET /flex` | Trade card PNG generation |
| `wss://api.traderouter.ai/ws` | Persistent WebSocket for limits / trailing / DCA / TWAP / combo orders |

## Trust anchor

The baked-in server public key is `EXX3nRzfDUvbjZSmxFzHDdiSYeGVP1EGr77iziFZ4Jd4`. Every `order_filled`, `order_created`, and `twap_execution` message from the server is verified with Ed25519 before being treated as authoritative. See [SECURITY.md](./SECURITY.md) for details and the rotation mechanism (`TRADEROUTER_SERVER_PUBKEY_NEXT`).

## Use with LangChain

Any MCP server works in LangChain via the official adapter:

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "traderouter": {
        "command": "npx",
        "args": ["-y", "@traderouter/trade-router-mcp"],
        "transport": "stdio",
        "env": {"TRADEROUTER_PRIVATE_KEY": "<base58>"},
    },
})
tools = await client.get_tools()
```

## Fees

Flat **1% fee on swap volume**, embedded in routing at `/protect`. No subscription, no API key, no monthly minimums. Read-only endpoints (`/holdings`, `/mcap`) are free.

## Security disclosure

Email **security@traderouter.ai** or use GitHub Security Advisories on this repo. 48-hour acknowledgement. See [SECURITY.md](./SECURITY.md).

## License

MIT. See [LICENSE](./LICENSE).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
