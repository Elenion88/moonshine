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

The cost of that is the thing it cannot do: it exchanges addresses, it does not
punch holes. Two machines on one network find each other; two behind separate
routers do not, unless a port is forwarded. **Hole punching is the next piece,
and it goes here.**

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

`heartbeat` is where the work happens. A device says where it thinks it is, and
is told where its siblings said they were — plus `observed`, the address this
service sees it coming from. That is the useful half of what a STUN server does,
for free, because the client already had to connect here.

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

- **Hole punching.** The reason this service exists at all is to make the next
  step possible; today it only gets you as far as directly reachable machines.
- **Email verification and password reset.** Neither exists. An address is
  currently just a username.
- **Device authentication.** A device is identified by an id it chooses, under a
  token. Good enough while the token is the real credential; not good enough
  once devices exchange keys.
