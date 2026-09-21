# HL-303 Adapter

ASP.NET Core registry service for Harness connection definitions. It deliberately does **not** contact Harness; each response reports `observationStatus: "not_checked"`.

## Runtime configuration

Only deployment wiring is read from environment variables:

- `Mongo__ConnectionString`, `Mongo__Database`
- `InternalAuth__Token` — required secret used by Gateway calls as `X-Internal-Token`
- `Centrifugo__PublishUrl`, `Centrifugo__ApiKey` — optional notification endpoint and secret

Health endpoints are unauthenticated: `GET /health/live` and `GET /health/ready` (the latter pings MongoDB). All `/api/connections` calls require `X-Internal-Token`.

## API

- `GET /api/connections/` — list registry entries
- `GET /api/connections/{id}` — fetch an entry
- `POST /api/connections/` — body `{"name":"prod","baseUri":"https://harness.example/api/v1"}`
- `PUT /api/connections/{id}` — same body; preserves `createdAt`

The stored document is `{id,name,baseUri,createdAt,updatedAt}`. `baseUri` must be an absolute `http`/`https` URI; its full path (and query, if supplied) is retained. Successful creates/updates make one best-effort HTTP POST to `Centrifugo__PublishUrl` with exactly `{"connectionId":"…","kind":"created|updated"}`. A publish failure is logged and never reverses the MongoDB write.

## Build and test

```powershell
docker build -t hl-303-adapter .
docker run --rm -p 8080:8080 -e Mongo__ConnectionString='mongodb://host.docker.internal:27017' -e Mongo__Database=hl303 -e InternalAuth__Token='<secret>' hl-303-adapter
docker run --rm -v ${PWD}:/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 dotnet restore Adapter.sln --use-lock-file
docker run --rm -v ${PWD}:/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 dotnet test Adapter.sln --no-restore
```
