# Deployment

Everything below assumes you want to play with people who are not on your
own network. On a single machine, `npm run dev` and `ws://localhost:2567/play`
need none of this.

## Why TLS is not optional here

A client's first frame is `hello`, and it carries that device's secret. Over
plain `ws://` anyone on the network path — a shared wifi network, a hotel
router, an ISP — can read it and then *be* that player: take their turns,
see their fog-of-war view, resign their matches.

So the server refuses plaintext connections from anything but loopback. That
is deliberate: forgetting TLS fails loudly at connect time instead of quietly
leaking credentials for months.

The refusal can be overridden with `REDLINE_ALLOW_INSECURE=1`, which exists
for closed test networks. It prints a warning at startup and every refused
connection, and you should not use it for a real game.

## Option A: a reverse proxy (recommended)

Let something else own the certificate and renewals. The game server stays
plaintext on loopback, and the proxy terminates TLS.

```
REDLINE_TRUST_PROXY=1 npm start
```

`REDLINE_TRUST_PROXY=1` tells the server to believe `X-Forwarded-Proto` —
but only from a loopback peer, because that header is client-settable and a
remote host claiming to be a proxy is just a remote host. Put the proxy on
the same machine, or in front of a loopback-bound listener.

Caddy, which obtains and renews a certificate automatically:

```
play.example.com {
    reverse_proxy localhost:2567
}
```

nginx, with a certificate from certbot:

```nginx
server {
    listen 443 ssl;
    server_name play.example.com;

    ssl_certificate     /etc/letsencrypt/live/play.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/play.example.com/privkey.pem;

    location /play {
        proxy_pass http://127.0.0.1:2567;
        proxy_http_version 1.1;

        # Without these two the WebSocket upgrade fails and the client sees
        # a connection that opens and immediately closes.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        # A turn can be minutes apart; do not time the socket out between them.
        proxy_read_timeout 3600s;
    }

    location /health {
        proxy_pass http://127.0.0.1:2567;
    }
}
```

Players then connect to `wss://play.example.com/play`.

## Option B: the server terminates TLS itself

One less moving part, but you own certificate renewal.

```
REDLINE_TLS_CERT=/etc/letsencrypt/live/play.example.com/fullchain.pem \
REDLINE_TLS_KEY=/etc/letsencrypt/live/play.example.com/privkey.pem \
npm start
```

The server then speaks `wss://` directly on its port. Setting only one of the
two is refused at startup rather than falling back to plaintext.

Node must be able to read the key, and the process needs restarting after
each renewal.

## Testing wss:// locally

```bash
tools/dev-cert.sh                 # writes server/.state/dev-cert/{cert,key}.pem
tools/live-check.sh --tls         # runs the whole stack over wss://
```

`live-check.sh --tls` generates a certificate, starts the server with it, and
runs the real Godot client against it over `wss://` — including a check that
the connection actually was encrypted, so a run that silently fell back to
plaintext cannot pass.

A self-signed certificate proves nothing about who the server is, so the
client rejects it unless told to trust that exact certificate:

```gdscript
Net.trust_certificate_file("user://dev-cert.pem")
```

Do not ship a build that trusts a pinned dev certificate, and do not disable
verification to make a self-signed certificate work — that removes the only
thing TLS was protecting.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `2567` | Listen port |
| `REDLINE_STATE_DIR` | `server/.state` | Matches and credentials. **Back this up; it contains credentials.** |
| `REDLINE_DATA_DIR` | found by walking up to `shared/data` | Read-only game data tables |
| `REDLINE_TLS_CERT` / `REDLINE_TLS_KEY` | unset | Terminate TLS here (Option B). Both or neither. |
| `REDLINE_TRUST_PROXY` | unset | Believe `X-Forwarded-Proto` from loopback (Option A) |
| `REDLINE_ALLOW_INSECURE` | unset | Serve plaintext to remote hosts. Leaks device secrets. |

Only an exact `1` enables the flags; `true` and `yes` do not.

## Checking what you deployed

The server prints its posture on startup:

```
Redline Commander server listening on wss://localhost:2567/play
Transport: TLS terminated here (wss://)
```

The four postures are distinct, and one of them says `INSECURE` in capitals.
If that is not what you expected, stop and fix it before telling anyone the
address.

`GET /health` returns `{"ok":true}` over whichever scheme is configured.

## Operational notes

- **`REDLINE_STATE_DIR` holds credentials.** It is gitignored; keep it out of
  world-readable locations and off public backups.
- **Losing it logs everyone out permanently.** Identities are trust-on-first-
  use, so a wiped credential store means every device is treated as new — and
  because seats are keyed to player id, matches in progress become
  unreachable. Back it up with the matches.
- **Storage is JSON files.** Fine for a group of friends. `MatchStore` and
  `CredentialStore` are three-method interfaces; swap in Postgres behind them
  before you have enough players to care.
- **Rate limiting is not implemented** (`docs/ROADMAP.md`). On a public
  address, put it in the proxy.
