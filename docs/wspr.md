# WSPR

DigiShack listens to WSPR — the Weak Signal Propagation Reporter beacon mode — and can
report what it hears to [wsprnet.org](https://wsprnet.org/). It does not transmit WSPR in
this release.

## Listening

Tune to a WSPR dial frequency (the band buttons on the decodes page do it: WSPR is a mode
beside FT8, FT4 and FT2) and the decoder switches to two-minute windows aligned to the even
UTC minute. Each window is decoded about 112 s in, and every station found appears in the
decode list as wsprd prints it — `K1ABC FN42 37`: callsign, grid, power in dBm — with its
SNR in 2500 Hz, its DT, and its audio frequency. Compound calls arrive as `PJ4/K1ABC 37`,
and six-character grids as `<PJ4/K1ABC> FK52UD 37` once the station's plain transmission
has been heard; before that the hash shows as `<...>`, exactly as WSJT-X shows it.

The first decode after a retune takes a while. Windows are cut at the even UTC minute
plus the 110.6 s transmission, and a window that began before the retune is too short to
decode, so a retune at the wrong moment waits up to about four minutes for its first
decode. The bridge's liveness watchdog, which restarts a pipeline that cuts no window,
allows WSPR six minutes (three of its own periods) rather than FT8's two. Until 1.188.1
it did not, and restarted the bridge back onto FT8 before the first WSPR window could
arrive, which looked exactly like the decoder not working.

The standard dial frequencies (the WSPR signal sits 1500 Hz above the dial):

| Band | Dial (MHz) | Band | Dial (MHz) |
|------|-----------:|------|-----------:|
| 160 m | 1.8366 | 17 m | 18.1046 |
| 80 m | 3.5686 | 15 m | 21.0946 |
| 60 m | 5.2872 | 12 m | 24.9246 |
| 40 m | 7.0386 | 10 m | 28.1246 |
| 30 m | 10.1387 | 6 m | 50.293 |
| 20 m | 14.0956 | 2 m | 144.489 |

## What happens to the automatic modes

Nothing on a WSPR frequency can be called: a beacon is not a CQ. So the automatic modes
refuse to start while the decoder is on WSPR, and if the radio lands on a WSPR frequency
while one is running, it is stopped and the log says so. The Call button is absent on a
WSPR decode. Transmit is refused for WSPR at the transmitter, whatever asks.

## Reporting to wsprnet

Settings → Logbooks → WSPR → **Report spots to wsprnet.org**. Off by default: a spot puts
this station's callsign and grid on a public map, which is the point of the service and a
thing to opt into. Each spot is one request in the format WSJT-X sends; failures are logged
once a minute at most and never cost a decode. The reporting callsign and grid are the
station's.

## The decoder, and how it was checked

`lib/digital/wspr.ts` (the codec) and `lib/digital/wsprdemod.ts` (the demodulator) are
ports of WSJT-X's `wsprd`, and were checked against the reference binaries built from the
same sources: every packed byte and channel symbol of seven messages against `wsprsim`, and
eight of the nine stations the reference decodes from the one WSPR recording WSJT-X
publishes — every field identical, the ninth a marginal decode lost to rounding. The
recording is the check's fixture. See the changelog for 1.185.0 and 1.186.0.

The decoder runs on its own thread: a two-minute window takes about three seconds of CPU,
and the bridge's main thread cannot be away that long while DAX audio keeps arriving. The
thread loads `lib/radio/wspr-worker.bundle.mjs`, plain JavaScript that esbuild builds from
the TypeScript decoder (`npm run build:wspr-worker`), because a worker thread on Node 20
does not inherit the bridge's TypeScript loader. The bundle is committed: after changing
anything under `lib/digital/wspr*` or the worker, rebuild it, and `npm run check` fails
while it is stale.

## Not yet

- Transmitting WSPR (a beacon on a schedule, at a chosen power).
- Listening to WSPR when idle, hopping bands, and feeding what is heard to the band-hop
  decision — the reason this mode was built first.
- The ordered-statistics decoder WSJT-X enables at its deepest setting, which recovers
  some marginal decodes.
