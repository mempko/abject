# deploy/ - Running Abject as a service

The headless edition (`pnpm incarnate:headless`, or the release archives
`abject-<version>-<os>-<arch>.tar.gz`) is one directory: the `abject` binary
(Node with the command line built in) and its `lib/`. It needs nothing
installed. node-datachannel and node-pty are native, so the archive is built
per platform and architecture.

For one person on their own machine, `abject service install` is all there is:
it registers a systemd user unit, a macOS LaunchAgent, or a Windows scheduled
task that runs the backend at login. This directory is for running it
machine-wide, as its own user.

## Install (Linux, systemd)

```bash
sudo useradd --system --home-dir /var/lib/abject --shell /usr/sbin/nologin abject
sudo mkdir -p /opt/abject /etc/abject
sudo tar -xzf abject-*-linux-x64.tar.gz -C /opt/abject --strip-components=1
sudo cp abject.env.example /etc/abject/abject.env   # then edit
sudo cp abject.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now abject
curl -s http://127.0.0.1:7719/healthz
```

## Talking to it

The service's data directory belongs to the `abject` user, and so does the
owner token in `/var/lib/abject/instance.json` that lets a local terminal in
without a login. Either run the command as that user:

```bash
sudo -u abject ABJECTS_DATA_DIR=/var/lib/abject /opt/abject/abject           # chat
sudo -u abject ABJECTS_DATA_DIR=/var/lib/abject /opt/abject/abject setup     # models, permissions, login
```

or set a login (`abject setup` offers one, as do `ABJECTS_AUTH_USER` and
`ABJECTS_AUTH_PASSWORD`) and connect from any account, or through an SSH
tunnel from another machine:

```bash
ssh -L 7723:127.0.0.1:7723 server        # on your machine
abject --url ws://127.0.0.1:7723
```

Permission prompts wait for an answer: `abject questions` lists them and
`abject answer N <choice>` answers one, or answer them in the chat
(`/questions`). For a machine nobody watches, `abject mode allow` or
`abject mode deny` decides every request no rule covers.

## Health and version

On WS_PORT, loopback only:

- `GET /healthz`: 200 `{ "status": "ok", version, edition, display, ready, uptimeSec, node, platform, arch, workerCount }`
  once boot has finished, 503 `{ "status": "starting", … }` before.
- `GET /version`: `{ "version" }`.

Abjects read the same through the `InstanceInfo` object (`getInfo`).

## Configuration

`abject.env.example` lists every environment variable. Beside those, the data
directory holds `packages.json` (packages, their settings) and `profiles.json`
(workspace profiles); see docs/PACKAGES.md and docs/WORKSPACE_PROFILES.md.

## Web browsing

The WebBrowser capability drives Chromium through Playwright, which ships in
the archive; the browser itself is downloaded on request:

```bash
sudo -u abject PLAYWRIGHT_BROWSERS_PATH=/var/lib/abject/browsers \
  /opt/abject/abject __abject-run /opt/abject/lib/node_modules/playwright/cli.js install chromium
sudo npx playwright install-deps chromium   # its system libraries
```

and set `PLAYWRIGHT_BROWSERS_PATH=/var/lib/abject/browsers` in `abject.env`.

## Docker

`Dockerfile` at the repository root builds the same edition into an image
(`ghcr.io/mempko/abject`): data in the `/data` volume, the CLI gateway on
7723.

```bash
docker run -d --name abject -v abject-data:/data -p 127.0.0.1:7723:7723 \
  -e ABJECTS_AUTH_USER=me -e ABJECTS_AUTH_PASSWORD=secret ghcr.io/mempko/abject
abject --url ws://127.0.0.1:7723
docker exec -it abject abject setup
```

## Not included

- **TLS.** The HTTP gateway serves plain HTTP. To expose it, bind it to
  loopback and put a TLS proxy (Caddy, nginx) in front.
- **A display.** The headless edition has no windows. The desktop app (or
  `pnpm awaken` from source) is the edition with a UI; the `abject` command
  talks to either.
