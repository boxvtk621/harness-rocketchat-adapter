# Harness Web — provider-independent observability

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
./scripts/bootstrap.ps1 -ProjectName hl305-my-session -ClientPort 18505 -KeycloakPort 18585 -Start
```

Run from this worktree's `web/`. The command creates a dedicated local acceptance environment and fresh infrastructure secrets under the ignored `.runtime/` directory. It never copies the working stack's secrets. Open <http://localhost:18505>, sign in through Keycloak as `operator` using `.runtime/secrets/keycloak_dev_user_password`, then use **Настройки** to register a name, complete HTTPS URI and observation interval, timeout and stale threshold. Bootstrap creates a local test certificate and a deliberately invalid Cursor fixture key; neither is a provider credential. The Harness build contexts are read from existing sibling repositories (or explicit `-CursorContext` / `-CodexContext` paths).

## Build, test, inspect, stop and restart

```powershell
docker compose --env-file .runtime/acceptance.env build
docker compose --env-file .runtime/acceptance.env --profile harness up -d
docker compose --env-file .runtime/acceptance.env ps
docker compose --env-file .runtime/acceptance.env logs --no-log-prefix gateway adapter
./scripts/verify-boundaries.ps1 -EnvironmentFile .runtime/acceptance.env
./scripts/accept.ps1
docker compose --env-file .runtime/acceptance.env stop
docker compose --env-file .runtime/acceptance.env start
```

`stop` preserves data. The generated environment file assigns the same unique `hl305-*` prefix to the Compose project, three networks and four named data volumes; Client and Keycloak use separate loopback ports. Always pass this environment file. Plain Compose retains the existing deployment defaults for compatibility and must not be used for acceptance. `accept.ps1` verifies effective project/network/volume names before starting anything; the test container also refuses to run without explicit isolation metadata. Existing volumes/networks require matching project labels and verified worktree containers (or an explicit matching `homelab.worktree` label). Orphaned volumes left by `compose down` are refused when ownership cannot be proven; use `stop/start` for persistence checks. No labels are retroactively applied to existing resources because Compose could recreate them. Cleanup of any existing data or volumes requires separate authorization.

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

The acceptance script runs Chromium inside Docker (no host Node/npm), temporarily joins the isolated Harness network as a TLS-verified test client, restarts only its own stack without deleting volumes, and runs the scenario again. Deterministic commands and a persisted fixture manifest prevent new registry, dialog or request records on repeated runs. Assertions cover exact counts and stable identities, concurrent duplicate registration, real queued/cancelled requests, multiple requests within one dialog, authentication, notification refetch, filtering, selection and inspector behavior. Controlled projection responses used for mixed-state screenshots are explicitly distinguished from real Harness lifecycle evidence. The one-shot container exits before the steady-state boundary check, where Adapter remains the sole production bridge to Harness. Evidence is under `web/output/acceptance/` and intentionally uncommitted.

The SPA reads public deployment wiring from `/runtime-config.js`; bootstrap generates this file with the isolated OIDC authority and Compose mounts it read-only. It contains no credentials. Business settings remain in Adapter/MongoDB.
