# Security Model

This document explains the security architecture of the Trade Router MCP server. It exists to address the "suspicious" verdict returned by static analysis tools (VirusTotal, ClawHub moderation, npm secret scanners) that cannot infer the non-custodial flow from observed behavior alone.

## TL;DR

- **Your private key never leaves your machine.** It is read once from `TRADEROUTER_PRIVATE_KEY`, used to sign transactions locally with `@solana/web3.js` + `tweetnacl`, and never transmitted, logged, or persisted.
- **The remote service (api.traderouter.ai) only receives signed transactions** — cryptographically sealed bundles that cannot be used to compromise the originating wallet.
- **Read-only operations (`/holdings`, `/mcap`) do not require any key at all.**
- **Server responses are Ed25519-verified** against a hard-coded trust anchor baked into the source (`EXX3nRzfDUvbjZSmxFzHDdiSYeGVP1EGr77iziFZ4Jd4`).

## Threat model

### What we protect against

| Threat | Mitigation |
|---|---|
| Private key exfiltration to remote service | Key never leaves the local process. Only signed transactions (which cannot be replayed beyond their single intended swap) are transmitted. |
| Key being logged/persisted on disk | Key is read from `TRADEROUTER_PRIVATE_KEY`, held in memory only for the signing operation, never written to disk. No log statement in the codebase includes the key. |
| Key being captured by a compromised dependency | All signing is performed via `@solana/web3.js` `Keypair.fromSecretKey()` + `tweetnacl`. No custom crypto. |
| MITM attack on API calls | All requests use HTTPS to api.traderouter.ai. |
| Server impersonation on `order_filled` / `order_created` / `twap_execution` events | Every server message is verified with Ed25519 against the hard-coded trust anchor (`EXX3nRzfDUvbjZSmxFzHDdiSYeGVP1EGr77iziFZ4Jd4`). See `verifyOrderFilled`, `verifyOrderCreated`, `verifyTwapExecution` in the source. Optional `TRADEROUTER_SERVER_PUBKEY_NEXT` supports key rotation. |
| Signature verification bypass | `TRADEROUTER_REQUIRE_SERVER_SIGNATURE=true` (default) and `TRADEROUTER_REQUIRE_ORDER_CREATED_SIGNATURE=true` (default) are fail-closed — if a server message fails verification, the client refuses it. |
| Sandwich / MEV attacks on the swap | `/protect` submits via Jito bundles, preventing mempool visibility. |
| Slippage abuse | Slippage is part of the order params hash (`params_hash`), which is signed by the server. Changing it invalidates the signature. |

### What's out of scope

- User running this MCP on a compromised machine (local key theft via malware is beyond our remit — user is responsible for operating system security).
- User revealing their private key via shell history, committing `.env` files to public repos, or exposing process env to unprivileged users.
- Attacks on Solana itself (consensus, validator compromise).

### What we explicitly do NOT validate (transparency)

The following trust assumptions are inherent to the current architecture. We document them so users can layer their own checks if needed:

| Trust assumption | What it means in practice |
|---|---|
| **The swap transaction returned by `POST /swap` is signed without inspecting its bytes.** | If `api.traderouter.ai` is compromised (operator, DNS hijack, BGP attack), the server could return a transaction that drains the wallet to an attacker-controlled address. The MCP would sign and submit it via `auto_swap`. The Ed25519 trust anchor only protects the *order-event* messages (`order_filled`, `order_created`, `twap_execution`), **not** the unsigned-tx response from `POST /swap`. |
| **Mitigations available to the user** | (a) Use `TRADEROUTER_DRY_RUN=true` for testing — see what would have been submitted. (b) Use a dedicated trading wallet with limited balance. (c) Wrap `auto_swap` calls at your agent layer with a tx-decode + amount-check before submission. (d) Use `build_swap` + manual `submit_signed_swap` flow if you want to inspect each transaction before sending. |
| **Build-swap response integrity** | The `/swap` endpoint response is HTTPS-protected (TLS) but is not Ed25519-signed by the server in the current API. Future versions may add this. |

We chose this trade-off because validating arbitrary Solana transaction bytes against expected swap parameters (token mints, amounts, intermediate routes across 4 DEXes, fee structures) is non-trivial and adds significant code surface. We err on the side of transparency: documented trust, with a kill-switch (`TRADEROUTER_DRY_RUN`), rather than implicit trust hidden behind security claims.

## Data flow

```
┌──────────────────────────────────────────────────────────────┐
│ LOCAL MACHINE                                                │
│                                                              │
│ 1. TRADEROUTER_PRIVATE_KEY env var ──► MCP server process    │
│                                         │                    │
│                                         │ (read once,        │
│                                         │  held in memory)   │
│                                         ▼                    │
│ 2. Agent calls swap tool    Local signing (@solana/web3.js   │
│                             + tweetnacl)                     │
│                                         │                    │
└─────────────────────────────────────────┼────────────────────┘
                                          │
                                          │   (NETWORK boundary)
                                          ▼
  POST /swap    { wallet_address, token, amount, action }
  POST /holdings { wallet_address }
  GET  /mcap    { token_mint }
       ↓
  api.traderouter.ai returns an unsigned transaction
                                          │
                                          │   (back to local)
                                          ▼
┌──────────────────────────────────────────────────────────────┐
│ LOCAL MACHINE                                                │
│                                                              │
│ 3. Unsigned tx signed with TRADEROUTER_PRIVATE_KEY (local)   │
│ 4. SIGNED tx submitted to /protect                           │
│                                                              │
│       >>> THE PRIVATE KEY NEVER LEAVES THIS BOX <<<          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
  POST /protect { signed_tx_base64 }
       ↓
  Server submits to Jito bundle
  Returns { signature, pre/post balances } — Ed25519 signed
       ↓
  Client verifies signature against hard-coded trust anchor
  before treating the fill as authoritative.
```

## What each endpoint sends

| Endpoint | Request contents | Never includes |
|---|---|---|
| `POST /swap` | wallet_address (public key), token_mint, action (buy/sell), amount | Private key, seed phrase, any signing material |
| `POST /protect` | signed_tx_base64 (fully signed transaction) | Private key, unsigned tx |
| `POST /holdings` | wallet_address only | Private key, any auth material |
| `GET /mcap` | token_mint(s) | Anything user-specific |
| `GET /flex` | wallet + token (for PNG generation) | Private key |
| WebSocket `/ws` | wallet_address to register, order params | Private key (signing happens client-side on fill) |

## Permissions manifest

```yaml
required_env_vars:
  TRADEROUTER_PRIVATE_KEY: "Required for any swap/order. Read once, used locally, never transmitted."

optional_env_vars:
  SOLANA_RPC_URL: "Defaults to https://api.mainnet-beta.solana.com. Used for local queries only."
  TRADEROUTER_SERVER_PUBKEY: "Override the baked-in server trust anchor. For testing or key rotation."
  TRADEROUTER_SERVER_PUBKEY_NEXT: "Accept messages signed by this key in addition to the primary. Supports rotation without a client upgrade."
  TRADEROUTER_REQUIRE_SERVER_SIGNATURE: "Default 'true'. Set 'false' to skip fill-event verification — NOT RECOMMENDED."
  TRADEROUTER_REQUIRE_ORDER_CREATED_SIGNATURE: "Default 'true'. Set 'false' to skip order-created verification — NOT RECOMMENDED."
  TRADEROUTER_DRY_RUN: "Default 'false'. When 'true', every write-action tool (submit_signed_swap, auto_swap, place_*_order, cancel_order, extend_order) short-circuits and returns { dry_run: true, ... } instead of calling the API. Read-only tools always execute. 1.0.9+."

network_access:
  - api.traderouter.ai:443   # HTTPS for REST
  - api.traderouter.ai:443   # WSS for the WebSocket (same host, upgrade)
  - SOLANA_RPC_URL host      # Only if set — direct Solana RPC for reads

filesystem_access:
  - read-only: none required
  - write: none required (server is stateless)

outbound_data:
  - wallet public addresses
  - token mints
  - swap parameters (amounts, slippage, expiry)
  - signed transactions
  NEVER:
  - private keys
  - seed phrases
  - unsigned transactions with key attached
  - keystore files
  - passwords
```

## User responsibilities

A perfect tool cannot protect you from the following — these are yours:

1. **Do not commit `.env` files to public repos.** Add `.env` to `.gitignore`.
2. **Do not export `TRADEROUTER_PRIVATE_KEY` in shells whose history is logged to shared systems** (shared servers, bastion hosts).
3. **Use a dedicated trading wallet with limited balance.** Treat it as a hot wallet, not your main holdings.
4. **Rotate keys periodically.** Every 30–90 days, move funds to a new wallet and stop using the old one.
5. **Run on trusted hardware.** Do not run this MCP on a machine you don't control.
6. **Set reasonable slippage.** Low-liquidity tokens require 15–25%; your own risk tolerance applies.

## Safety features built in

- **Ed25519 signature verification** on every `order_filled`, `order_created`, and `twap_execution` server message, against the hard-coded trust anchor `EXX3nRzfDUvbjZSmxFzHDdiSYeGVP1EGr77iziFZ4Jd4` (see `_HARDCODED_SERVER_PUBKEY` in the source). Fails closed.
- **Server key rotation support** via `TRADEROUTER_SERVER_PUBKEY_NEXT` — operators can rotate without clients upgrading.
- **Params-hash binding** — the `params_hash` fields in `order_created` include slippage, expiry, and amount. A server that tries to silently alter those for MEV/profit would break its own signature.
- **No custom crypto.** All signing uses `@solana/web3.js` `Keypair.fromSecretKey()` + `tweetnacl`; all hashing uses Node's built-in `createHash('sha256')`.
- **Dry-run mode** (1.0.9+) — set `TRADEROUTER_DRY_RUN=true` and every write-action tool short-circuits and returns `{ dry_run: true, tool, args, note }` without touching the network. Read-only tools (`get_*`, `build_swap`, `list_orders`, `check_order`, `connection_status`) still execute so you can explore safely.
- **Regression tests** (1.0.9+) — `test/preimage.test.mjs` pins the exact `params_hash` preimage shape per order type (8 fields for limit/trailing, 10 for TWAP variants, 11 for `limit_trailing_twap`). Wired into CI on every push/PR across Node 18/20/22 so the specific bug caught during the 2026-04-24 audit cannot silently recur.

## What is NOT in this release

Transparency about features that have been discussed but are not in the shipped code:

- **Daily loss caps** — not implemented in the MCP server. If you need this, wrap the tool calls at your agent layer, or use the reference-agent pattern documented in the ClawHub skill's `SKILL.md` which implements `MAX_DAILY_LOSS_LAMPORTS` and a `KILL_SWITCH`.
- **On-disk transaction log** — not implemented. The server is stateless by design.

If you see a reference to any of these in external documentation, treat it as forward-looking and verify against the source before relying on it.

## Disclosure

Found a vulnerability? Email **security@traderouter.ai** or use GitHub Security Advisories on this repo.

We commit to:
- Acknowledge within 48 hours
- Fix critical issues within 7 days
- Credit the reporter publicly (with their consent)

## Audit status

- 2026-04-24: Self-audited, documentation-complete (this file). External audit pending.
- A formal audit from a reputable firm (Offside Labs / OtterSec / Zellic) is planned for Q2 2026.

## License

See `LICENSE`. MIT.
