# Harness Web — HL-304 provider-independent registry

Local-only integration stack containing Angular SPA, .NET Gateway, .NET Adapter, MongoDB, Keycloak, Centrifugo and two real Harness processes (Cursor and Codex). The acceptance fixture submits commands to both Harness processes in a fail-closed manual-dispatch mode, exercises queued-to-cancelled lifecycle projections, and never dispatches provider work or uses real provider credentials.

## Repository layout and boundaries

- The repository root owns Adapter and MongoDB access.
- This `web/` directory owns the SPA, Gateway and Compose topology.
- Browser → Client → Gateway → Adapter → MongoDB is the only business-data path.
- Gateway has no DB driver, credentials, queries, migrations, cache or database-backed session.
- Adapter is the only service connected to the isolated Harness network; Harness services publish no host ports.
- Centrifugo payloads only invalidate client state; the SPA always re-reads the API.
- Nodes separates HTTP reachability, executor health, readiness/capacity and heartbeat freshness. Work and History are typed provider-neutral projections.

## Local bootstrap

The proposed bootstrap boundary is narrow: application/business settings are entered through the Web and stored by Adapter; only machine-generated infrastructure credentials are written to the gitignored `.runtime/secrets` directory and mounted as Docker secrets. Checked-in files contain no credential values.

```powershell
./scripts/bootstrap.ps1 -Start
```

The command prints the one local operator password. Open <http://localhost:18100>, sign in through Keycloak, then use **Настройки** to register a name, complete absolute HTTPS URI and independent interval/timeout/stale-threshold settings. Bootstrap creates a local CA-style test certificate and a deliberately invalid Cursor fixture key; neither is a provider credential.

## Build, test, inspect, stop and restart

```powershell
docker compose build
docker compose --profile harness up -d
docker compose ps
docker compose logs --no-log-prefix gateway adapter
./scripts/verify-boundaries.ps1
./scripts/accept.ps1
docker compose stop
docker compose start
```

`stop` preserves the isolated `hl304-mongodb-data`, `hl304-keycloak-data`, `hl304-cursor-harness-data` and `hl304-codex-harness-data` volumes. Set `HL304_VOLUME_PREFIX` when parallel worktrees need independent non-destructive fixtures. `docker compose down` also preserves volumes unless `--volumes` is explicitly supplied. Only Client `18100` and Keycloak `18180` publish loopback ports. The project uses dedicated `hl304-web`, internal `hl304-internal`, and internal-only `hl304-harness` networks.

## Authentication and notifications

The SPA uses Authorization Code + PKCE as a public client and stores the short-lived session in `sessionStorage`. Gateway validates Keycloak JWT issuer, audience, lifetime and signature. Gateway creates a five-minute Centrifugo client token after authenticated API access. The Adapter alone holds the Centrifugo publish API key; the browser never receives it. A publish failure is logged after persistence and does not roll back or repeat the database write.

The local realm has one minimal development user and is not a final team-role model. Session expiry returns 401, and the client requires a fresh sign-in. Centrifugo publications and reconnects refetch the visible Nodes, Work, History or Settings projection; missed publications are acceptable because API/MongoDB remain authoritative.

## Fixed versions and resource budget

- .NET SDK/runtime 10.0 images
- Angular 22.1.7, Node 24.18.0
- Keycloak 26.4.2
- MongoDB 8.0.16
- Centrifugo 5.4.8
- nginx 1.29.4

Compose resource limits are development guardrails, not production sizing.

The acceptance script runs Chromium inside Docker (no host Node/npm), temporarily joins the internal Harness network as a TLS-verified test client, restarts the stack without deleting its named volumes, and runs the browser scenario again to prove persistence. It checks anonymous 401, two independent Keycloak sessions, registration of both real Harness nodes, path-preserving settings, heartbeat/boot identity, real queued Work and cancelled History projections from both Harness processes, Harness-event/Centrifugo-driven refetch in the second client, reload recovery, logout, simulated expiry, QHD screenshots, and the 390 px no-overflow invariant. The one-shot acceptance container exits before the steady-state boundary check, where Adapter remains the only production service on the Harness network. Evidence is written under `output/acceptance/` and is intentionally not committed.
