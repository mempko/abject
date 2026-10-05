# deploy/ - Running Abject as a service

`pnpm incarnate:server` builds `release/abject-server-<version>-<platform>-<arch>.tar.gz`:
the compiled server, its workers, the bundled packages, and its runtime
dependencies. It needs Node 22.5 or newer on the machine and nothing else.
node-datachannel is native, so build the archive on the platform and
architecture it will run on.

## Install (Linux, systemd)

```bash
sudo useradd --system --home-dir /var/lib/abject --shell /usr/sbin/nologin abject
sudo mkdir -p /opt/abject /etc/abject
sudo tar -xzf abject-server-*.tar.gz -C /opt/abject --strip-components=1
sudo cp /opt/abject/deploy/abject.env.example /etc/abject/abject.env   # then edit
sudo cp /opt/abject/deploy/abject-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now abject-server
curl -s http://127.0.0.1:7719/healthz
```

## Health and version

On the UI port, loopback only:

- `GET /healthz`: 200 `{ "status": "ok", version, ready, uptimeSec, node, platform, arch, workerCount }`
  once boot has finished, 503 `{ "status": "starting", … }` before.
- `GET /version`: `{ "version" }`.

Abjects read the same through the `InstanceInfo` object (`getInfo`).

## Configuration

`abject.env.example` lists every environment variable. Beside those, the data
directory holds `packages.json` (packages, their settings) and `profiles.json`
(workspace profiles); see docs/PACKAGES.md and docs/WORKSPACE_PROFILES.md.

## Not included

- **Playwright** (the WebBrowser capability) is optional. To use it, run
  `npm install playwright && npx playwright install --with-deps chromium` in
  `/opt/abject`.
- **TLS.** The HTTP gateway serves plain HTTP. To expose it, bind it to
  loopback and put a TLS proxy (Caddy, nginx) in front.
