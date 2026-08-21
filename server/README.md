# The coordinator

The smallest thing that can answer *"which machines are mine, and where are they
right now"*.

Sign in on two machines and they can find each other — no tailnet, no addresses
to remember, nothing for the person to configure.

```bash
npm install
npm run build
npm run dev          # local, plain HTTP, port 8787
```

## What it is not

**It is not a relay.** No stream traffic passes through it, ever. That is the
single most important property here, and everything else follows from it:

- The bandwidth bill is zero. A relayed 1080p session is roughly 13 GB an hour,
  per session, and paying for that is what turns a tool into a business with a
  margin problem.
- It is off the critical path. A session already running does not care that
  this service is down, because nothing about the stream goes through it.
- It never holds video. The only things it knows are which machines belong to
  which account and what addresses they last reported.

The cost of that is the thing it still cannot do. It now punches holes - see
below - but carrying a *stream* over a punched path needs a tunnel, and that is
not built. Two machines on one network reach each other; two behind separate
routers can prove they have a path, and cannot yet use it.

## API

All JSON. Everything except `/health`, `/v1/signup` and `/v1/login` needs
`Authorization: Bearer <token>`.

| | |
|---|---|
| `GET /health` | liveness |
| `POST /v1/signup` | `{email, password}` → `{token, userId, email}` |
| `POST /v1/login` | `{email, password}` → `{token, userId, email}` |
| `POST /v1/logout` | revoke the bearer token |
| `POST /v1/devices` | `{id?, name, os}` → `{deviceId}` |
| `GET /v1/devices` | every device on the account |
| `DELETE /v1/devices/:id` | forget one |
| `POST /v1/heartbeat` | `{deviceId, endpoints}` → `{observed, peers}` |
| `POST /v1/punch/ticket` | `{deviceId}` → `{ticket, udpPort}` |

`heartbeat` is where the work happens. A device says where it thinks it is, and
is told where its siblings said they were — plus `observed`, the address this
service sees it coming from. That is the useful half of what a STUN server does,
for free, because the client already had to connect here.

## The rendezvous

A UDP socket on the same port number as the HTTP server, and the reason two
machines behind routers can reach each other at all.

A NAT forwards an inbound packet only if something inside sent one outward to
that address first. So there is no "server" side to a punch: both machines have
to send at roughly the same moment, each opening the mapping the other's packet
needs. The rendezvous answers where and when:

1. `{t:'bind'}` — tells a device what address its packets appear to come from,
   which is the one thing a machine behind a router cannot work out for itself,
   and remembers the mapping.
2. `{t:'connect', target}` — answers the asker with the target's address *and*
   pokes the target through the mapping it has been keeping open, so both start
   sending at once. That poke is the whole technique.

Then they talk directly and this service is out of the loop.

Mappings expire in 90 seconds and clients re-bind every 20, because routers drop
theirs in as little as 30.

**Authentication is a short-lived ticket, not the bearer token.** These packets
are unencrypted UDP; putting a long-lived credential in them would trade a
session for a session's worth of eavesdropping. A ticket lasts 60 seconds, names
one device, and is checked against the account before any address is handed
over — so knowing a device id is not enough to have this service point a
stranger at someone else's machine.

## No dependencies

Not a slogan, a check you can run: `npm ls --prod` is empty. `node:http`,
`node:sqlite` and `node:crypto` are the whole stack.

`node:sqlite` is still marked experimental by Node, which is the one caveat
worth knowing — the API could change under a major version. The surface used
here is about six calls wide, which is a smaller risk than a dependency tree. It
needs `--experimental-sqlite`, which `npm start` passes.

## Security

- **It refuses to start over plain HTTP** unless you pass `--insecure` or set
  `MOONSHINE_TRUST_PROXY=1`. It handles passwords; running it unencrypted by
  accident should not be possible.
- Passwords are scrypt with OWASP's parameters and a per-user salt, compared in
  constant time. A login for an account that does not exist still pays the same
  ~100 ms, so a missing account and a wrong password are indistinguishable.
- Signup on an existing address returns the same shape as a failed login, so the
  endpoint cannot be used to test which addresses have accounts.
- Tokens are 256 bits from the CSPRNG and stored server-side, so revoking one is
  a `DELETE`. Deliberately not JWTs: a token you cannot revoke is a liability in
  exchange for a database read this service can easily afford.
- Auth endpoints are rate limited per address, in memory. That resets on restart
  and does not survive more than one process — fine at this size, and not to be
  forgotten if it grows.

## Deploying

Put it behind something that terminates TLS, set `MOONSHINE_TRUST_PROXY=1` so
observed addresses are the client's rather than the proxy's, and give it a
persistent volume for `MOONSHINE_DB`.

| | |
|---|---|
| `MOONSHINE_PORT` | default 8787 |
| `MOONSHINE_DB` | default `./data/coordinator.db` |
| `MOONSHINE_TRUST_PROXY` | `1` when behind a reverse proxy |

## Still to do

- **The tunnel.** Punching produces a verified UDP path between two ephemeral
  ports. Sunshine listens on its own TCP and UDP ports, and carrying those over
  that path is the remaining work - and the point of everything above.
- **Testing against real NATs.** The protocol is verified on loopback, which
  proves the exchange and the synchronisation and traverses nothing. Two
  machines on different networks are needed to prove the rest.
- **Email verification and password reset.** Neither exists. An address is
  currently just a username.
- **Device authentication.** A device is identified by an id it chooses, under a
  token. Good enough while the token is the real credential; not good enough
  once devices exchange keys.
