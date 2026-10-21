#!/bin/bash
# Makes ws://localhost:<port> inside the hosted mcp container reach a relay on the
# host, so the server and the wallet page use the same local relay url.
# Run it after hosted-up.sh and again after every restart of the mcp container.
# Usage: relay-forward.sh <run-dir> [port, default 18080]
set -euo pipefail
RUN=$1
PORT=${2:-18080}
P=$(sed -n 's/^COMPOSE_PROJECT=//p' "$RUN/run.env")
C=$(docker compose -p "$P" -f "$(dirname "$0")/compose.yaml" ps -q mcp 2>/dev/null)
docker rm -f "$P-relay-forward" >/dev/null 2>&1 || true
docker run -d --name "$P-relay-forward" --network "container:$C" --pull never -e PORT="$PORT" "jaw-verify-mcp:$P" node -e '
const net = require("net");
const port = Number(process.env.PORT);
const forward = (c) => {
  const r = net.connect(port, "host.docker.internal");
  c.pipe(r).pipe(c);
  c.on("error", () => r.destroy());
  r.on("error", () => c.destroy());
};
for (const host of ["127.0.0.1", "::1"]) net.createServer(forward).listen(port, host);
' >/dev/null
echo "relay forward on localhost:$PORT for $P"
