# deploy/ - Running Abject as a Service

The headless edition (`pnpm incarnate:headless`, or the release archives
`abject-<version>-<os>-<arch>.tar.gz`, `.zip` on Windows) is one directory:
the `abject` binary (Node with the command line built in) and its `lib/`. It
needs nothing installed. node-datachannel and node-pty are native, so the
archive is built per platform and architecture.

For one person on their own machine, `abject service install` is all there is:
it registers a systemd user unit, a macOS LaunchAgent, or a Windows scheduled
task that runs the backend at login. This directory is for running it
machine-wide, as its own user, and for the container image.

## Files

- **abject.service**: a systemd system unit. Runs `/opt/abject/abject serve` as
  user `abject` with `EnvironmentFile=/etc/abject/abject.env`, working
  directory and `StateDirectory` `/var/lib/abject`, `Restart=on-failure`,
  `TimeoutStopSec=30` with `KillMode=control-group` (child processes such as
  MCP servers go with it), and hardening (`ProtectSystem=strict`,
  `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`; writable only
  `/var/lib/abject`).
- **abject.env.example**: every environment variable a service is likely to
  set, commented: the data directory and `HOME`, ports and interfaces, a
  login, worker sizing, package directories, Chromium's location, and the peer
  network's signaling servers and admission.

Neither file is in the release archive; take them from this directory.

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
owner token in `/var/lib/abject/instance.json` (mode 0600) that lets a local
terminal in without a login. Either run the command as that user:

```bash
sudo -u abject ABJECTS_DATA_DIR=/var/lib/abject /opt/abject/abject           # chat
sudo -u abject ABJECTS_DATA_DIR=/var/lib/abject /opt/abject/abject setup     # models, permissions, login
```

or set a login (`abject setup` offers one, as do `ABJECTS_AUTH_USER` and
`ABJECTS_AUTH_PASSWORD`) and name the gateway from any other account, or
through an SSH tunnel from another machine:

```bash
abject --url ws://127.0.0.1:7723         # another account on the server
ssh -L 7723:127.0.0.1:7723 server        # on your machine
abject --url ws://127.0.0.1:7723
```

Permission prompts wait for an answer: `abject questions` lists them and
`abject answer N <choice>` answers one, or answer them in the chat
(`/questions`). For a machine nobody watches, `abject mode allow` or
`abject mode deny` decides every request no rule covers.

## Health and version

On `WS_PORT`, loopback only:

- `GET /healthz`: 200 `{ "status": "ok", version, ready, startedAt, uptimeSec, node, platform, arch, workerCount, edition, display }`
  once boot has finished, 503 `{ "status": "starting", ... }` before.
- `GET /version`: `{ "version" }`.

Abjects read the same through the `InstanceInfo` object (`getInfo`), and
`abject status` prints it.

## Configuration

`abject.env.example` lists the variables; `server/README.md` has the full
table. Beside those, the data directory holds `packages.json` (packages, their
settings) and `profiles.json` (workspace profiles); see `docs/PACKAGES.md` and
`docs/WORKSPACE_PROFILES.md`. Global settings (models, permissions, login)
are changed through `abject setup`, `abject settings`, or `/settings` in the
chat.

## Web browsing

The WebBrowser capability drives Chromium through Playwright, which ships in
the archive; the browser itself is downloaded on request:

```bash
sudo -u abject PLAYWRIGHT_BROWSERS_PATH=/var/lib/abject/browsers \
  /opt/abject/abject __abject-run /opt/abject/lib/node_modules/playwright/cli.js install chromium
sudo npx playwright install-deps chromium   # its system libraries
sudo systemctl restart abject
```

`abject serve` uses `<data directory>/browsers` by itself when that folder
exists; set `PLAYWRIGHT_BROWSERS_PATH` in `abject.env` to keep browsers
elsewhere.

## Docker

`Dockerfile` at the repository root builds the same directory into an image
(`ghcr.io/mempko/abject`, built for linux/amd64 and linux/arm64 by the release
workflow). The final stage is Debian slim with the `abject` binary as the whole
runtime, running as user `abject` (uid 10001) under tini. Data lives in the
`/data` volume; the CLI gateway listens on 7723 on every interface inside the
container (`CLI_BIND=0.0.0.0`), so publish it on the host's loopback and set a
login. The health check runs `abject status`.

```bash
docker run -d --name abject -v abject-data:/data -p 127.0.0.1:7723:7723 \
  -e ABJECTS_AUTH_USER=me -e ABJECTS_AUTH_PASSWORD=secret ghcr.io/mempko/abject
abject --url ws://127.0.0.1:7723
docker exec -it abject abject setup
```

## Gotchas

- **`abject setup` is written for one person's machine.** Against a
  machine-wide service, skip its Chromium download and its start-at-login
  step: after a download it restarts the backend itself, which stops the
  service's backend and starts another outside systemd, and installing start
  at login also stops the running backend first. Use the commands above
  instead. In a container the same restart stops the container's main process.
- **The container image has no Chromium system libraries**, so web browsing
  there needs an image built on top of it with them.
- **Logs.** Under systemd the backend logs to the journal
  (`journalctl -u abject`); `abject logs` reads only
  `<data directory>/logs/abject.log`, written by backends `abject start`
  launched.
- **A second backend on the same data directory refuses to start**, so stop
  the service before running `abject serve` or `abject start` by hand against
  `/var/lib/abject`.

## Not included

- **TLS.** The HTTP gateway serves plain HTTP. To expose it, bind it to
  loopback and put a TLS proxy (Caddy, nginx) in front.
- **A display.** The headless edition has no windows. The desktop app (or
  `pnpm awaken` from source) is the edition with a UI; the `abject` command
  talks to either.

## Related

- [server/README.md](../server/README.md): ports, health, auth, environment variables
- [cli/README.md](../cli/README.md): the `abject` command
- [packaging/README.md](../packaging/README.md): package-manager installs
- [scripts/README.md](../scripts/README.md): `package-headless.mjs`
