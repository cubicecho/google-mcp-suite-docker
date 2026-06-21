# google-mcp-suite-network

![Gmail](https://img.shields.io/badge/Gmail-%2Fgmail%2Fmcp-EA4335?logo=gmail&logoColor=white)
![Calendar](https://img.shields.io/badge/Calendar-%2Fcalendar%2Fmcp-4285F4?logo=googlecalendar&logoColor=white)
![Sheets](https://img.shields.io/badge/Sheets-%2Fsheets%2Fmcp-34A853?logo=googlesheets&logoColor=white)
![Docs](https://img.shields.io/badge/Docs-%2Fdocs%2Fmcp-4285F4?logo=googledocs&logoColor=white)
![Drive](https://img.shields.io/badge/Drive-%2Fdrive%2Fmcp-FBBC04?logo=googledrive&logoColor=white)
![Health](https://img.shields.io/badge/Health-%2Fhealthz-success)

A tiny TypeScript wrapper that takes [`google-mcp-suite`](https://github.com/simiancraft/google-mcp-suite)
— five **stdio** MCP servers for Gmail, Calendar, Sheets, Docs, and Drive — and
exposes each one over the network as a **Streamable HTTP** MCP endpoint, so you
can run it once on a homelab/Docker host and point any MCP client at it.

```
MCP client  ──HTTP──►  this proxy  ──stdio──►  google-mcp-<service>  ──►  Google APIs
```

Each service is mounted at its own path:

| Service  | Endpoint            |
|----------|---------------------|
| Gmail    | `/gmail/mcp`        |
| Calendar | `/calendar/mcp`     |
| Sheets   | `/sheets/mcp`       |
| Docs     | `/docs/mcp`         |
| Drive    | `/drive/mcp`        |

Plus `GET /healthz` for health checks and `GET /` for a service listing.

Every incoming HTTP session spawns its own child stdio server (identity in this
suite is bound per process) and JSON-RPC messages are bridged transparently in
both directions.

## How it works

- `src/index.ts` runs an Express server. On the MCP `initialize` request it
  spawns the matching `google-mcp-<service>` binary and wires its stdin/stdout
  to a `StreamableHTTPServerTransport`. The session id maps to that child for
  follow-up requests; closing either side tears down the other.
- No tool logic is duplicated — the proxy forwards raw JSON-RPC, so every
  operation the suite ships is available unchanged.

## Prerequisites: Google OAuth

`google-mcp-suite` needs a Google Cloud **OAuth client (Desktop app type)** and
per-account tokens stored in `~/.google-mcp/`. It loads these at startup, so a
service endpoint only works once its account is authorized.

1. In Google Cloud: create a project, enable the Gmail/Calendar/Sheets/Docs/Drive
   APIs, create a **Desktop app** OAuth client, and download the client secret.
2. Save it as `client_secret.json`.

### Authorize an account (recommended: on your workstation)

The consent flow opens a browser and uses a loopback redirect, which is awkward
in a headless container. The simplest path is to authorize on a machine with a
browser, then ship the resulting `~/.google-mcp/` into the Docker volume.

```sh
# On your workstation (Node 22+):
npm i -g google-mcp-suite
mkdir -p ~/.google-mcp && cp client_secret.json ~/.google-mcp/
google-mcp-doctor scopes                 # see required APIs/scopes
google-mcp-doctor auth you@example.com   # browser consent -> writes the token
google-mcp-doctor                        # verify every account is reachable
```

Then load the populated directory into the named volume used by compose:

```sh
docker volume create google-mcp-suite-docker_google-mcp-config
docker run --rm \
  -v google-mcp-suite-docker_google-mcp-config:/dest \
  -v "$HOME/.google-mcp:/src:ro" \
  alpine sh -c 'cp -a /src/. /dest/'
```

> The volume name is `<project-dir>_google-mcp-config`. Confirm yours with
> `docker volume ls` after the first `docker compose up`.

### Alternative: authorize inside the container

```sh
docker compose run --rm \
  -v "$PWD/client_secret.json:/home/node/.google-mcp/client_secret.json:ro" \
  google-mcp-suite google-mcp-doctor auth you@example.com
```

This writes the token into the persistent volume. If no browser is available,
the doctor prints a URL to complete consent manually.

## Run

```sh
cp .env.example .env       # set GOOGLE_MCP_ACCOUNT and (recommended) AUTH_TOKEN
docker compose up -d --build
curl localhost:3000/healthz
```

### Configuration

| Variable             | Default | Purpose                                                            |
|----------------------|---------|--------------------------------------------------------------------|
| `PORT`               | `3000`  | Published port.                                                    |
| `GOOGLE_MCP_ACCOUNT` | —       | Account label/email bound to every service (must match `doctor auth`). |
| `<SERVICE>_ACCOUNT`  | —       | Per-service override, e.g. `GMAIL_ACCOUNT`, `DRIVE_ACCOUNT`.       |
| `AUTH_TOKEN`         | —       | If set, every `/<service>/mcp` request needs `Authorization: Bearer <token>`. |
| `HOST`               | `0.0.0.0` | Bind address.                                                   |
| `BODY_LIMIT`         | `50mb`  | Max JSON body (Drive uploads ride inside JSON-RPC).               |

## Connect an MCP client

Point any Streamable-HTTP-capable MCP client at the per-service URL. Example
(`.mcp.json` style):

```json
{
  "mcpServers": {
    "gmail": {
      "type": "http",
      "url": "http://your-homelab-host:3000/gmail/mcp",
      "headers": { "Authorization": "Bearer YOUR_AUTH_TOKEN" }
    },
    "drive": {
      "type": "http",
      "url": "http://your-homelab-host:3000/drive/mcp",
      "headers": { "Authorization": "Bearer YOUR_AUTH_TOKEN" }
    }
  }
}
```

Drop the `headers` block if you did not set `AUTH_TOKEN`.

## Local development

```sh
npm install
npm run dev      # tsx watch
npm run build    # tsc -> dist/
npm start        # node dist/index.js
```

## Security notes

- Set `AUTH_TOKEN` whenever the port is reachable beyond `localhost`. The bearer
  check is the only access control in front of full read/write access to your
  Google account.
- Terminate TLS at a reverse proxy (Caddy / Traefik / nginx) if exposing it
  beyond your LAN.
- Tokens live only in the `google-mcp-config` volume; back it up accordingly.
