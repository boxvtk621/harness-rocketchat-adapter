# HL-304 Adapter

ASP.NET Core registry and observation service for provider-independent Harness nodes. Adapter is the only component allowed to contact Harness; Angular and Gateway consume typed Nodes, Work and History projections from Adapter.

Adapter lives at the root, while Angular Client, .NET Gateway, Docker Compose, Keycloak and Centrifugo wiring live under [`web/`](web/README.md).

## Runtime configuration

Only deployment wiring is read from environment variables:

- `Mongo__ConnectionString`, `Mongo__Database`
- `InternalAuth__Token` — required secret used by Gateway calls as `X-Internal-Token`
- `Centrifugo__PublishUrl`, `Centrifugo__ApiKey` — optional notification endpoint and secret
- `Harness__AllowedHosts` — exact comma-separated destination allowlist
- `Harness__CaFile` — optional private CA used only for Harness TLS

Health endpoints are unauthenticated: `GET /health/live` and `GET /health/ready` (the latter pings MongoDB). All `/api/connections` calls require `X-Internal-Token`.

## API

- `GET /api/connections/` — list registry entries and current observations
- `GET /api/connections/{id}` — fetch an entry
- `POST /api/connections/` — register a base URI and independent observation interval, request timeout and stale threshold
- `PUT /api/connections/{id}` — update the same settings; increments `configEpoch`
- `GET /api/projections/nodes` — reachability, health, readiness/capacity, heartbeat freshness, boot identity and compatibility
- `GET /api/projections/work` — provider-neutral active work items
- `GET /api/projections/history` — provider-neutral completed work items

Base paths and queries are retained when Harness endpoint paths are joined. Redirects, URI userinfo/fragments, non-HTTPS schemes, private-network destinations outside the exact allowlist, cookies and credential forwarding are refused. A compare-and-set `configEpoch` prevents a late response for an old URI from overwriting a newer observation. SSE keepalive is never treated as executor heartbeat.

## Build and test

```powershell
docker build -t hl-304-adapter .
docker run --rm -v ${PWD}:/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 dotnet restore Adapter.sln --use-lock-file
docker run --rm -v ${PWD}:/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 dotnet test Adapter.sln --no-restore
```

For the complete local stack:

```powershell
cd web
./scripts/bootstrap.ps1 -Start
./scripts/accept.ps1
```
