# google-mcp-suite-network

![Gmail](https://img.shields.io/badge/Gmail-%2Facct%2Fgmail-EA4335?logo=gmail&logoColor=white)
![Calendar](https://img.shields.io/badge/Calendar-%2Facct%2Fcalendar-4285F4?logo=googlecalendar&logoColor=white)
![Sheets](https://img.shields.io/badge/Sheets-%2Facct%2Fsheets-34A853?logo=googlesheets&logoColor=white)
![Docs](https://img.shields.io/badge/Docs-%2Facct%2Fdocs-4285F4?logo=googledocs&logoColor=white)
![Drive](https://img.shields.io/badge/Drive-%2Facct%2Fdrive-FBBC04?logo=googledrive&logoColor=white)
![Health](https://img.shields.io/badge/Health-%2Fhealthz-success)

A tiny TypeScript wrapper that takes [`google-mcp-suite`](https://github.com/simiancraft/google-mcp-suite)
— five **stdio** MCP servers for Gmail, Calendar, Sheets, Docs, and Drive — and
exposes each one over the network as a **Streamable HTTP** MCP endpoint, so you
can run it once on a homelab/Docker host and point any MCP client at it.

```
MCP client  ──HTTP──►  this proxy  ──stdio──►  google-mcp-<service>  ──►  Google APIs
```

Each request is addressed as `/<account>/<service>`, so one deployment can serve
several authorized Google accounts. `<account>` is a label you authorize in the
`/admin` UI (its email or any `[A-Za-z0-9._%+@-]` name); `<service>` is one of:

| Service  | Endpoint                  |
|----------|---------------------------|
| Gmail    | `/<account>/gmail`        |
| Calendar | `/<account>/calendar`     |
| Sheets   | `/<account>/sheets`       |
| Docs     | `/<account>/docs`         |
| Drive    | `/<account>/drive`        |

For example, `POST /you@example.com/gmail`. Plus `GET /healthz` for health checks
and `GET /` for a service + authorized-account listing.

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

### Easiest: the `/admin` web UI

The container ships a small credential UI at **`/admin`** that uploads the client
secret and runs the per-account OAuth flow for you, writing the same files into
the persistent volume that `google-mcp-doctor auth` would.

1. Set `ADMIN_PASSWORD` (and optionally `ADMIN_USER`, default `admin`) in `.env`,
   then `docker compose up -d --build`.
2. Open `http://localhost:3000/admin`, upload your `client_secret.json`, enter an
   account label/email, and click **Start authorization**.
3. Approve in Google. If you opened the UI on the same machine, the redirect
   completes automatically — refresh the page. If the UI is on another host, the
   browser lands on a `localhost` page that won't load: copy that full URL from
   the address bar and paste it back into the UI to finish.

The account label you authorize is the `<account>` segment you put in the request
URL, e.g. `/you@example.com/gmail`. Tokens land in the volume at
`~/.google-mcp/tokens/`. Authorize as many accounts as you like — each is
addressable independently.

> The UI manages OAuth secrets, so `ADMIN_PASSWORD` is required: without it every
> `/admin` route returns 503 (and startup warns). When the published
> port isn't `3000`, set `OAUTH_REDIRECT_BASE` to match (e.g.
> `http://localhost:8080`).

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
cp .env.example .env       # set ADMIN_PASSWORD and (recommended) AUTH_TOKEN
docker compose up -d --build
curl localhost:3000/healthz
# then authorize one or more accounts at http://localhost:3000/admin
```

### Configuration

| Variable             | Default | Purpose                                                            |
|----------------------|---------|--------------------------------------------------------------------|
| `PORT`               | `3000`  | Published port.                                                    |
| `AUTH_TOKEN`         | —       | If set, every `/<account>/<service>` request needs `Authorization: Bearer <token>`. |
| `ADMIN_PASSWORD`     | —       | HTTP Basic password for the `/admin` credential UI. **Required** — unset = every `/admin` route returns 503 (warned at startup). |
| `ADMIN_USER`         | `admin` | HTTP Basic username for `/admin`.                                 |
| `OAUTH_REDIRECT_BASE`| `http://localhost:<PORT>` | Loopback base for the OAuth redirect URI; match your published port. |
| `HOST`               | `0.0.0.0` | Bind address.                                                   |
| `BODY_LIMIT`         | `50mb`  | Max JSON body (Drive uploads ride inside JSON-RPC).               |

## Connect an MCP client

Point any Streamable-HTTP-capable MCP client at the `/<account>/<service>` URL,
using an account you authorized in `/admin`. Example (`.mcp.json` style):

```json
{
  "mcpServers": {
    "gmail": {
      "type": "http",
      "url": "http://your-homelab-host:3000/you@example.com/gmail",
      "headers": { "Authorization": "Bearer YOUR_AUTH_TOKEN" }
    },
    "drive": {
      "type": "http",
      "url": "http://your-homelab-host:3000/you@example.com/drive",
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

## Releases & Docker image

Released images are published to Docker Hub at
[`vantreeseba/google-mcp-suite`](https://hub.docker.com/r/vantreeseba/google-mcp-suite).
Pull a pinned version (or `latest`) instead of building locally:

```sh
docker pull vantreeseba/google-mcp-suite:latest
```

To run the published image, set `image: vantreeseba/google-mcp-suite:latest`
in `docker-compose.yml`, remove the `build: .` line, and run
`docker compose up -d` (without `--build`).

Versioning is automated with [semantic-release](https://semantic-release.gitbook.io/).
On every push to `main`, GitHub Actions analyzes the
[Conventional Commits](https://www.conventionalcommits.org/) since the last
release and, when a release is warranted:

- bumps the version and updates `CHANGELOG.md`,
- creates the Git tag and GitHub release,
- builds and pushes `vantreeseba/google-mcp-suite:<version>` and `:latest`.

Commit messages drive the version bump: `fix:` → patch, `feat:` → minor,
`feat!:`/`BREAKING CHANGE:` → major. Commits like `chore:`/`docs:` alone do not
trigger a release.

### CI setup

The release workflow (`.github/workflows/release.yml`) requires two repository
secrets for Docker Hub auth (Settings → Secrets and variables → Actions):

- `DOCKERHUB_USERNAME` — your Docker Hub username (`vantreeseba`).
- `DOCKERHUB_TOKEN` — a Docker Hub [access token](https://hub.docker.com/settings/security)
  with Read & Write scope.

`GITHUB_TOKEN` is provided automatically by Actions.

## Security notes

- Set `AUTH_TOKEN` whenever the port is reachable beyond `localhost`. The bearer
  check is the only access control in front of full read/write access to your
  Google account.
- Terminate TLS at a reverse proxy (Caddy / Traefik / nginx) if exposing it
  beyond your LAN.
- Tokens live only in the `google-mcp-config` volume; back it up accordingly.
