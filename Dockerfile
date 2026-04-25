# Lightweight container so MCP marketplaces (Glama, Smithery, etc.)
# can spin up the server, send a `tools/list` introspection request,
# and verify the 21 tools are advertised.
#
# This image is for marketplace introspection only — production users
# should `npx -y @traderouter/trade-router-mcp` instead.

FROM node:20-alpine

WORKDIR /app

# Install just the published package and its runtime deps.
RUN npm install --no-audit --no-fund --omit=dev @traderouter/trade-router-mcp@1.0.9

# Stdio transport — marketplaces drive it via stdin/stdout.
# TRADEROUTER_PRIVATE_KEY is intentionally unset so the introspection
# check doesn't need a wallet; tools/list works without it.
ENTRYPOINT ["npx", "-y", "@traderouter/trade-router-mcp"]
