# Support

Where to ask what.

| You want to... | Go to |
|---|---|
| Report a bug | [Open a bug report](https://github.com/TradeRouter/trade-router-mcp/issues/new?template=bug.yml) |
| Request a feature | [Open a feature request](https://github.com/TradeRouter/trade-router-mcp/issues/new?template=feature.yml) |
| Report a security issue | Email `security@traderouter.ai` — **do not** open a public issue. See [SECURITY.md](./SECURITY.md). |
| Read the API docs | <https://traderouter.ai> · <https://traderouter.ai/SKILL.md> · <https://traderouter.ai/openapi.json> |
| See full changelog | [CHANGELOG.md](./CHANGELOG.md) · <https://traderouter.ai/CHANGELOG.md> |
| See example agents | <https://github.com/TradeRouter/cookbook> (7 working examples: instant swap, DCA, trailing stop, mcap-trigger, combo, ElizaOS, LangChain) |
| Compare to Jupiter | <https://traderouter.ai/vs-jupiter> |
| General product questions | `hello@traderouter.ai` |
| X / Twitter | [@trade_router](https://x.com/trade_router) |

## Response expectations

- Security reports: 48-hour acknowledgement
- Bug reports: triaged within 1 week
- Feature requests: triaged within 2 weeks; no commitment to ship
- General email: within 3 business days

## Before opening a bug

Please check:

1. You're on the latest version (`npm i -g @traderouter/trade-router-mcp@latest`).
2. The bug reproduces with `TRADEROUTER_DRY_RUN=true` (so we know it's not a network/wallet issue).
3. There's no existing issue covering it — search [open issues](https://github.com/TradeRouter/trade-router-mcp/issues).
4. The 10 regression tests still pass on your machine: `npm test`.

If all four are clean and the bug still reproduces, open a report — that signal is gold.
