# What is reachable, and from where

Written after an unauthenticated sweep of the live install from three vantage points: the LAN,
the operator's own egress address, and a host on another network entirely. Recorded because
"nothing is exposed" is a claim that decays, and the next person to ask deserves the method
rather than the conclusion.

## The result

**No API route returns data without authentication.** All 62 were enumerated from the source
and every guarded one answered `401` with a fixed body:

    {"error":"Not signed in","details":{"needsSetup":false}}

The eight unguarded routes are unguarded on purpose, and each was checked rather than assumed:

| Route | Why it is open | Verified |
| --- | --- | --- |
| `/api/health` | Liveness for a monitor | Version, uptime, and whether the DB and bridge answer. No log data, no settings, no callsigns. |
| `/api/auth/login` | Obviously | Throttled — see below |
| `/api/auth/logout` | Clears a cookie | — |
| `/api/auth/me` | The client asks who it is | Returns `{"user":null,"needsSetup":false}` with no cookie |
| `/api/auth/forgot` | Password reset request | Rate-limited per address |
| `/api/auth/reset` | Consumes an emailed token | — |
| `/api/auth/setup` | First-run only | `POST` with a full admin payload answers `409 DigiShack is already set up` |
| `/api/qsl/card/[id]` | The recipient has no account | HMAC token required; a one-character change gives 404 |
| `/api/qsl/unsubscribe` | Same | HMAC token required |

Also checked and refused: `.env`, `.env.local`, `package.json`, `prisma/schema.prisma`,
`data/lotw/cert.json`, `.git/config`. Spoofed `X-Forwarded-For`, `X-Real-IP` and
`X-Forwarded-Host` change nothing; a forged `Host` gets `403`.

## The shape of the install

`cloudflared` runs a tunnel that connects OUT to Cloudflare and forwards inbound requests to
nginx over loopback. Nothing is port-forwarded, so the public address answers on no port at
all — `443`, `3000` and `3101` are all refused from outside.

The bridge (`3101`) binds to `127.0.0.1` only and is unreachable even from the LAN.

## What the sweep found wrong

**Every request appeared in the access log as `::1`.** True of a request from another continent
as much as a local one, and correct as far as nginx knew: the tunnel is what connected, from
loopback. The damage was in the two places that consume it — the login throttle keys on
`X-Real-IP`, so every attacker on earth shared one bucket and the key collapsed to the email
address alone; and `Session.ip` recorded `::1` for every session ever created, an audit trail
that cannot answer the only question ever asked of it. Fixed with `real_ip_header
CF-Connecting-IP` trusting loopback alone.

**The web tier listened on every interface.** `next start` binds `0.0.0.0` by default, so
`http://<lan-ip>:3000` reached the application directly, bypassing nginx. Authentication still
held there — that was checked, not assumed — so no data was exposed; what was bypassed was
nginx's body-size limit, its logging and its header handling. Now `next start -H 127.0.0.1`.

## Repeating it

    # every route, no credentials
    for r in $(...enumerate pages/api...); do curl -s -o /dev/null -w "%{http_code} $r\n" "$BASE/$r"; done

From the operator's own machine this is NOT an external test: the host and the VM share an
egress address, so anything trusting that address would admit the tester and refuse a stranger.
Use a genuinely off-network vantage point for the result to mean anything.
