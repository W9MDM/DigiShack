# Contributing

## Conventions this codebase actually follows

**Comments explain the FAULT, not the fix.** A surprising number of the comments here
describe something that went wrong, what was measured, and what was tried and rejected.
That is deliberate: several exist because a wrong conclusion was reached twice, and the
second time cost hours. If you fix something subtle, write down what fooled you.

**Say which facts are measured and which are assumed.** This software talks to radios
whose documented and actual behaviour differ often enough that the distinction is
load-bearing. A FlexRadio accepts display settings it never reflects in status, and never
broadcasts a change to its noise blanker at all. Where the code relies on something
unverified it says so; please keep doing that rather than implying certainty.

**A test whose input cannot reproduce the real fault is worse than no test.** It reports
success while the thing is broken. The noise model in `scripts/check-panadapter.ts` is the
case that established this: uniform 4 dB scatter passed every assertion while the real
display was unreadable, because a genuine FFT bin's noise spreads 12.65 dB.

## Checks

`npm run check` runs everything, and is long. While iterating, run the `check:*` scripts
for the area you are touching. Some need a database (`DATABASE_URL`); the rest are pure.

## Two processes

- `digishack-web` — the Next.js application.
- `digishack-bridge` — the radio service. It owns the radio, the decoders and the
  transmitter, and runs separately because it binds a UDP socket, which cannot be shared
  across cluster workers.

Changes under `services/` or `lib/radio/` need the bridge restarted. Changes to `pages/`
or `components/` need the web tier rebuilt — it runs `next start`, which serves built
output, so a pull without a build changes nothing.

## Transmitting

Anything that can key a transmitter is gated, and the gates are not decoration: an
unattended station that misbehaves is a nuisance to people who did not choose to run this
software. Do not add a path that transmits outside the transmit gate, and do not add a
default that puts a callsign on the air.
