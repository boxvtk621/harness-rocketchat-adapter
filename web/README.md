# Harness Web — HL-303 local foundation

Local-only development foundation for the first delivery of HL-301. It contains six isolated services: Angular SPA, .NET Gateway, .NET Adapter, MongoDB, Keycloak and Centrifugo. It does **not** contact Harness or Rocket.Chat and does not execute agent work.

## Repository layout and boundaries

- The repository root owns Adapter and MongoDB access.
- This `web/` directory owns the SPA, Gateway and Compose topology.
- Browser → Client → Gateway → Adapter → MongoDB is the only business-data path.
- Gateway has no DB driver, credentials, queries, migrations, cache or database-backed session.
- Centrifugo payloads only invalidate client state; the SPA always re-reads the API.
- Work/History/Nodes intentionally show empty or unknown states until later stages.

## Local bootstrap

The proposed bootstrap boundary is narrow: application/business settings are entered through the Web and stored by Adapter; only machine-generated infrastructure credentials are written to the gitignored `.runtime/secrets` directory and mounted as Docker secrets. Checked-in files contain no credential values.

```powershell
./scripts/bootstrap.ps1 -Start
```

The command prints the one local operator password. Open <http://localhost:18000>, sign in through Keycloak, then use **Настройки** to register a name and a complete absolute HTTP(S) URI, including any path.

## Build, test, inspect, stop and restart

```powershell
docker compose build
docker compose up -d
docker compose ps
docker compose logs --no-log-prefix gateway adapter
./scripts/verify-boundaries.ps1
./scripts/accept.ps1
docker compose stop
docker compose start
```

`stop` preserves named volumes `hl303-mongodb-data` and `hl303-keycloak-data-v2`. `docker compose down` also preserves them unless `--volumes` is explicitly supplied. All published ports are loopback-only: Client `18000`, Keycloak `18080`. The project uses dedicated networks `hl303-web` and `hl303-internal`.

## Authentication and notifications

The SPA uses Authorization Code + PKCE as a public client and stores the short-lived session in `sessionStorage`. Gateway validates Keycloak JWT issuer, audience, lifetime and signature. Gateway creates a five-minute Centrifugo client token after authenticated API access. The Adapter alone holds the Centrifugo publish API key; the browser never receives it. A publish failure is logged after persistence and does not roll back or repeat the database write.

The local realm has one minimal development user and is not a final team-role model. Session expiry returns 401, and the client requires a fresh sign-in. Centrifugo reconnect causes an API refresh when the Settings screen is open; missed publications are acceptable because API/MongoDB remain authoritative.

## Fixed versions and resource budget

- .NET SDK/runtime 10.0 images
- Angular 22.1.7, Node 24.18.0
- Keycloak 26.4.2
- MongoDB 8.0.16
- Centrifugo 5.4.8
- nginx 1.29.4

Compose limits the whole development stack to about 2 GiB and 4.5 CPUs. These are development guardrails, not production sizing.

The acceptance script runs Chromium inside Docker (no host Node/npm), restarts the stack without deleting its named volumes, and runs the browser scenario again to prove persistence. It checks anonymous 401, two independent Keycloak sessions, create/update with path preservation, Centrifugo-driven refetch in the second client, reload recovery from API, logout, simulated expired stored session, QHD section screenshots, and the 390 px no-document-overflow invariant. Evidence is written under `output/acceptance/` and is intentionally not committed.
