# WHISPER.md - The Whisper Signaling Server (+ TURN relay)

`whisper` is the signaling server (`server/signaling-server.ts`). It is how
peers find each other: it registers peers by their true name (PeerId), answers
"where is peer X?" queries, relays the WebRTC handshake (SDP offers/answers and
ICE candidates) between them, and hands out ICE servers (STUN, plus TURN
credentials when a relay is configured). No application message content passes
through it.

This document covers running `whisper` in production behind TLS, and pairing it
with a **TURN relay (coturn)** so peers that cannot reach each other directly
(symmetric NAT, CGNAT, most cell networks) can still connect.

- The public deployment is `wss://signal.abject.world`, which instances use by
  default (`PeerRegistry`, and `RemoteUIAccess` for pairing).
- The thin client (`client.abject.world`) and the peer mesh both rely on it.
- It is not the only path between peers. Once connected, every peer relays
  signaling for others over its DataChannels (`SignalingRelay`) and gossips
  peer lists (`PeerDiscovery`), so the mesh keeps finding itself when the
  server is down.
- `whisper` runs from a source checkout (`pnpm whisper`); the desktop app and
  the headless edition do not ship it.

## Protocol

JSON text frames over one WebSocket per peer. Each frame has a `type`:

| Client sends | Server does |
|--------------|-------------|
| `register` `{ peerId, publicSigningKey, publicExchangeKey, name }` | Binds the peerId to this socket, replies `registered`, and sends the updated `peer-list` to every other registered peer |
| `unregister` `{ peerId }` | Removes the binding (only for the peerId bound to this socket) |
| `find` `{ targetPeerId }` | Replies `found` (the peer's keys and name) or `not-found` |
| `list-peers` `{ peerId }` | Replies `peer-list`: every registered peer but the caller |
| `sdp-offer`, `sdp-answer`, `ice-candidate` `{ targetPeerId, sdp \| candidate }` | Relays the frame to the target, stamped with the sender's registered peerId. A socket must register before it relays, and a frame claiming another peerId is refused |
| `get-ice` | Replies `ice-servers` `{ iceServers }` |
| `ping` | Replies `pong` and keeps the peer fresh |

A frame that is not JSON, has no `type`, or carries a `peerId`,
`targetPeerId` or `name` longer than 1024 characters is dropped. An unknown
type gets an `error` reply. A peer whose socket closes is removed at once; one
silent for five minutes is removed by a sweep that runs every minute.

`SignalingServer` also has `enableFederation({ siblingUrls })`, which links
sibling servers and forwards `find` misses to them. The standalone entry
(`pnpm whisper`) does not turn it on.

## Why TURN

A WebRTC DataChannel normally forms by hole-punching: each side discovers its
public address via STUN and the two connect directly. On many networks (carrier
CGNAT, symmetric NAT, locked-down corporate Wi-Fi) the public mapping differs
per destination, so hole-punching fails and there is no direct path. STUN alone
cannot fix this.

TURN solves it by relaying the encrypted media through a server that both peers
can reach. The identity handshake and AES-256-GCM encryption still happen end to
end on top of the DataChannel, so the TURN server only ever sees ciphertext.

### How credentials flow

`whisper` mints short-lived TURN credentials and serves them over the signaling
WebSocket both peers already hold, so the shared secret never leaves the server.

```
  client / server                     whisper                    coturn
  ---------------                     -------                     ------
  1. connect (wss)  ───────────────▶
  2. {type:"get-ice"} ─────────────▶  mint creds:
                                      username = "<expiry>:<peerId>"
                                      credential = base64(HMAC-SHA1(
                                        TURN_SECRET, username))
  3. {type:"ice-servers",        ◀──  reply STUN + TURN urls + creds
      iceServers:[...]}
  4. build RTCPeerConnection with those iceServers
  5. if direct fails, ICE relays media ───────────────────────────▶ relay
```

coturn is configured with the same `TURN_SECRET` as `static-auth-secret`, so the
credential `whisper` mints authenticates against coturn without per-user
accounts (the coturn "REST API" / time-limited credential mechanism).

When `TURN_SECRET` is unset, `whisper` replies with STUN only and everything
keeps working without a relay. TURN is purely additive.

## Local development

No TURN needed for local testing. Just run the signaling server:

```bash
pnpm whisper                    # listens on :7720 (SIGNALING_PORT)
```

Point an instance at `ws://localhost:7720`: add it under Network → Servers &
Peers, or start the backend with `ABJECTS_SIGNALING_URLS=ws://localhost:7720`
to use only it. With no `TURN_SECRET`, `get-ice` returns the default public
STUN server only.

## Production deployment

Three pieces on the signaling host: `whisper` (a Node process), an nginx TLS
front for `wss://`, and coturn for the relay.

### 1. Run whisper as a service

`whisper` is `tsx server/signaling-server.ts`. Run it under a process manager so
it restarts on crash and boot. A systemd unit:

```ini
# /etc/systemd/system/abject-whisper.service
[Unit]
Description=Abjects signaling server (whisper)
After=network.target

[Service]
WorkingDirectory=/path/to/abject/
# systemd uses a minimal PATH and does NOT load your shell profile. If pnpm
# lives under nvm/corepack, point ExecStart at its absolute path AND add its
# bin dir to PATH so pnpm's `#!/usr/bin/env node` shebang resolves.
Environment=PATH=/home/<user>/.nvm/versions/node/<ver>/bin:/usr/bin:/bin
ExecStart=/home/<user>/.nvm/versions/node/<ver>/bin/pnpm whisper
Environment=TURN_SECRET=<shared-secret>
Environment=TURN_URLS=turns:signal.abject.world:5349,turn:signal.abject.world:3478
Restart=always
RestartSec=2
User=<user>

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now abject-whisper
systemctl status abject-whisper --no-pager
ss -ltnp | grep 7720          # confirm it is listening
```

If you see `pnpm: No such file or directory` (`status=127`), the PATH is wrong:
find the real binary with `command -v pnpm` (in a login shell) and use that
absolute path in `ExecStart` plus its parent dir in `Environment=PATH`.

### 2. Front it with TLS (nginx)

Browsers on HTTPS pages can only open `wss://` (not `ws://`). Terminate TLS at
nginx and proxy the WebSocket to `whisper` on `:7720`. See the
`signal.abject.world` block in [site/nginx.conf](site/nginx.conf) for the full
config. The essential part:

```nginx
location / {
    proxy_pass http://127.0.0.1:7720;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;     # keep long-lived signaling sockets open
}
```

### 3. Install and configure coturn

```bash
sudo apt-get update && sudo apt-get install -y coturn
echo 'TURNSERVER_ENABLED=1' | sudo tee /etc/default/coturn
```

A ready-to-edit config is in [site/turnserver.conf](site/turnserver.conf).
Install it and fill the two placeholders:

```bash
sudo cp site/turnserver.conf /etc/turnserver.conf
# external-ip = this host's PUBLIC IP (use <public>/<private> behind 1:1 NAT, e.g. cloud)
sudo sed -i 's/REPLACE_WITH_PUBLIC_IP/<public-ip>/' /etc/turnserver.conf
# static-auth-secret MUST equal whisper's TURN_SECRET
sudo sed -i 's/REPLACE_WITH_SHARED_SECRET/<shared-secret>/' /etc/turnserver.conf
sudo systemctl enable --now coturn
```

Generate the shared secret once with `openssl rand -hex 32` and use the same
value for both coturn's `static-auth-secret` and whisper's `TURN_SECRET`.

### 4. Enable `turns:` (TLS relay) for locked-down networks

Plain `turn:3478` (UDP/TCP) covers most cell networks. The strictest networks
(corporate, captive portals) allow only 443/TLS, where `turns:5349` is the
candidate that gets through. coturn can reuse the Let's Encrypt cert nginx
already manages. `site/turnserver.conf` already sets these for
`signal.abject.world` (along with `realm=abject.world`); point them at your own
domain:

```
tls-listening-port=5349
cert=/etc/letsencrypt/live/signal.abject.world/fullchain.pem
pkey=/etc/letsencrypt/live/signal.abject.world/privkey.pem
```

Let coturn (running as user `turnserver`) read the cert, and reload it after
renewal:

```bash
sudo apt-get install -y acl
sudo setfacl -R -m u:turnserver:rX /etc/letsencrypt/live /etc/letsencrypt/archive
printf '#!/bin/sh\nsystemctl try-reload-or-restart coturn\n' | \
  sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-coturn.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-coturn.sh
sudo systemctl restart coturn
```

### 5. Open the firewall

TURN needs the control ports AND the UDP relay range (`min-port`/`max-port` in
the conf). Open these in both the host firewall and any cloud security group:

```bash
sudo ufw allow 3478/tcp && sudo ufw allow 3478/udp     # STUN + TURN
sudo ufw allow 5349/tcp                                 # TURN over TLS
sudo ufw allow 49152:65535/udp                          # UDP relay range
```

The UDP relay range is the step most often missed. Without it, allocation
succeeds but no media flows.

## Verifying

Run these on the signaling host. None of them reveal `TURN_SECRET` (only
ephemeral, time-limited credentials).

**1. whisper serves TURN credentials.** Probe `get-ice` over the local socket:

```bash
cd /path/to/abject
node -e 'const W=require("ws");const s=new W("ws://localhost:7720");
  s.on("open",()=>s.send(JSON.stringify({type:"get-ice"})));
  s.on("message",d=>{console.log(d.toString());process.exit(0)});
  setTimeout(()=>process.exit(1),5000)'
```

Expect a reply containing a `turns:`/`turn:` entry with a `username` like
`<expiry>:anon` (the probe never registered, so it has no peerId) and a
`credential`. If you only see STUN, `TURN_SECRET` or
`TURN_URLS` did not reach the running process (`systemctl show abject-whisper -p Environment`).

**2. The credential authenticates against coturn.** Mint one and allocate a relay:

```bash
read U W < <(node -e 'const W=require("ws");const s=new W("ws://localhost:7720");
  s.on("open",()=>s.send(JSON.stringify({type:"get-ice"})));
  s.on("message",d=>{const j=JSON.parse(d.toString());
    const t=j.iceServers.find(x=>x.username);
    console.log(t.username+" "+t.credential);process.exit(0)})')
turnutils_uclient -e 8.8.8.8 -t -n 1 -u "$U" -w "$W" -p 3478 127.0.0.1
```

A `401` means the secrets differ: align coturn's `static-auth-secret` with
whisper's `TURN_SECRET`. A `403 Forbidden IP` against a loopback or private peer
is expected (the conf denies relaying to internal ranges); a public peer such as
`8.8.8.8` should bind without error.

**3. End to end.** Pair a phone over cell data, open `chrome://webrtc-internals`,
and confirm the selected candidate pair is type `relay`. To force the relay path
on a healthy network for testing, set `iceTransportPolicy: 'relay'` when building
the `RTCPeerConnection`.

## Configuration

Environment variables read by `whisper` (`server/signaling-server.ts`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNALING_PORT` | `7720` | Port whisper listens on |
| `TURN_SECRET` | (unset) | Shared secret for minting TURN credentials. Must equal coturn's `static-auth-secret`. Unset = STUN only. |
| `TURN_URLS` | (unset) | Comma-separated TURN URLs advertised to clients, e.g. `turns:signal.abject.world:5349,turn:signal.abject.world:3478` |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs advertised to clients |
| `TURN_TTL` | `43200` (12h) | Lifetime in seconds of each minted credential |

`whisper` listens on every interface. On a public host, leave 7720 closed in
the firewall and let nginx reach it on loopback.

## How clients use it

Both sides fetch ICE servers via `SignalingClient.requestIceServers()`
(`src/network/signaling.ts`) and pass them into `PeerTransport`.
`requestIceServers()` resolves to an empty list after 3 seconds, when not
connected, or against an older signaling server that does not understand
`get-ice`; the transport then falls back to its built-in STUN default
(`stun:stun.l.google.com:19302`). The consumers:

- `client/webrtc-transport.ts` (the thin mobile/web client, the caller)
- `src/objects/remote-ui-access.ts` (a desktop answering paired UI clients;
  the headless edition has no display to pair with, so no RemoteUIAccess)
- `src/objects/peer-registry.ts` (the peer-to-peer mesh, both editions)

On the backend these objects live in the dedicated P2P worker
(`workers/p2p-worker-runtime.ts`), unless `ABJECTS_DEDICATED_WORKERS=0` keeps
them on the main thread.

## A private signaling server

A server of your own is only private if your instances use nothing else. By
default an instance starts on `wss://signal.abject.world`, adds signaling
servers it learns from peers, and connects to every peer it finds there. Two
settings close that:

- **Fixed signaling.** `ABJECTS_SIGNALING_URLS=wss://signal.example.org`
  makes those the only servers the instance uses: no public default, no
  servers learned from peers or contacts' addresses. Pairing for the remote
  UI (desktop) uses the first of them unless `REMOTE_UI_SIGNALING_URL` names
  another. Without the variable, the same choice is the "Use only these
  servers" checkbox under Network → Servers & Peers (or
  `PeerRegistry.setFixedSignaling` by message), applied to the servers listed
  there.
- **Mesh admission.** Whisper accepts any registration, so anyone who knows
  the address can register, see the peer list, and try to connect.
  `ABJECTS_PEER_ADMISSION=allowlist` makes an instance refuse every peer not
  on its allowed list. The list is set at runtime (Who Can Connect in the
  Network window, or `PeerRegistry.setPeerAdmission` / `allowPeer` by
  message) and seeded by `ABJECTS_ALLOWED_PEERS`. The check runs on each
  incoming offer, before each outgoing connection, and again on the peer's
  proven identity once the encrypted handshake completes; removing a peer
  disconnects it.

Admission applies to the peer mesh. Remote UI clients pair with single-use
tokens and are not on the peer list.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `pnpm: No such file or directory`, `status=127` | systemd PATH does not include pnpm. Use absolute `ExecStart` + `Environment=PATH=` with the nvm/corepack bin dir. |
| `Start request repeated too quickly` | Crash loop. Fix the underlying error, then `systemctl reset-failed abject-whisper`. Add `RestartSec=2`. |
| `get-ice` returns STUN only | `TURN_SECRET`/`TURN_URLS` not set on the whisper process. Check `systemctl show abject-whisper -p Environment`. |
| Clients use STUN only although `get-ice` works on your server | They are talking to an older signaling server that predates `get-ice`. The client takes its `Unknown message type: get-ice` error as "no ICE servers" and falls back to STUN without logging it. Check which server the instance uses (Network → Servers & Peers) and deploy the updated one. |
| TURN test returns `401` | coturn's `static-auth-secret` does not match whisper's `TURN_SECRET`. |
| No `relay` candidate on a real client | Firewall: open UDP 3478 and the UDP relay range externally (cloud security group included). |
| `turns:` candidate never connects | coturn not listening on 5349, or cert unreadable by the `turnserver` user. |
