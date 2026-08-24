# Troubleshooting

Roughly in the order you are likely to meet them.

## No decodes

**Check the clock first**, and the Digital page will now tell you: it takes the
median DT across recent decodes, which measures your own offset because everyone
else's errors cancel. If it says your clock is out, believe it before checking
anything else.

FT8 tolerates about ±2 s of error, FT4 less, FT2 less again — and past that you get a
screen full of nothing, which looks exactly like a dead band. The UTC clock in the
header is there so a wrong zone gets noticed rather than deduced from an hour of
failures. If it disagrees with [time.is](https://time.is), fix that before anything
else.

Then, in order:

1. **Is the bridge running?** `npm run bridge`. Its startup lines say whether it found
   the radio, which DAX channel it took, and whether the transmitter attached.
2. **Is the radio on a digital frequency in DIGU?** A slice in USB on 14.200 decodes
   nothing and looks completely healthy.
3. **Is DAX on?** The DAX channel has to be enabled on the slice in SmartSDR.
4. **Is another program holding DAX?** WSJT-X and DigiShack cannot both have the same
   channel.
5. **Silent windows.** If the guard reports "silent receive windows", the audio path is
   dead rather than the band quiet — those windows carried no audio at all, not merely
   no decodes.

## It hears but will not transmit

- **`flex.allowTransmit`** is off. It is the master gate and it is re-read before every
  transmission.
- **FT-0 is engaged.** Releasing it brings the radio back but deliberately does *not*
  re-enable transmit.
- **A guard has paused it.** The Digital page shows the reason. A `fault` pause — SWR,
  PA temperature, deaf receiver — will not clear by changing band, and is telling you to
  look at the antenna.
- **`preflight` blockers** on the status: transmit inhibited on the radio, DAX not
  selected, another client holding the transmitter, a non-DIGU slice.
- **The radio is silently ignoring us.** If TX audio goes nowhere and `rfpower` does
  nothing, the connection is not a GUI client. A non-GUI client connects, subscribes and
  receives perfectly, and its transmit audio is discarded without error.

## The automatic mode stopped

Every guard reports why on the Digital page. The two that are not resettable by making
progress are the run-length and QSO-count limits — those are working as intended, and
the [settings](settings.md#automatic-operating-limits) raise them.

## POTA chase makes no contacts

Almost always the band. Chase captures its home band when you enable it, so **set the
band first**. If `pota.chaseBands` is `any`, it will follow spots to 160 m Poland at
20:00 UTC and sit there deaf for the give-up period. See [POTA](pota.md#chase-mode).

## Wrong times everywhere

Every displayed time carries a `Z` or the word UTC. If one does not, that is a bug —
report it. If they all look shifted, the machine's clock or zone is wrong, not the
application: nothing here reads a local time getter, and `npm run check:time` proves it
by running itself under two timezones 25 hours apart.

## Credentials stopped working after a move

`SETTINGS_KEY` did not come across. Service credentials are encrypted with it and it
lives in `.env`, never in the database. Copy the line from the old machine and restart.
See [Backup](backup-and-moving.md#the-settings-key).

## Every query fails after a restore, on Linux

Table-name case. The dump came from a server that folds names and this one does not.
Full explanation and both fixes: [the Linux trap](backup-and-moving.md#the-linux-trap).

## PM2 shows the bridge but the radio never comes up

Look at `logs/bridge-err.log`. A crash loop there is invisible from `pm2 list`,
which cheerfully shows the app as present while it restarts nine times and gives up.

If it says `SyntaxError: missing ) after argument list` near a line containing
`sed`, the `script` entry is pointing at `node_modules/.bin/tsx` — the npm shell
shim — and Node is trying to parse it as JavaScript. It should be
`node_modules/tsx/dist/cli.mjs`. Fixed in 0.65.0.

## The bridge exits when I close the terminal

`npm run bridge` runs in the foreground and belongs to the shell that started it.
Use `npx pm2 start ecosystem.config.js` for anything you expect to survive.

## Prisma will not regenerate

```
EPERM: operation not permitted, rename '…query_engine-windows.dll.node.tmp…'
```

The web app or the bridge is holding the query engine. Stop both, run
`npx prisma generate`, start them again.

## Duplicate or tripled decodes

Fixed, but if it recurs: an effect cleanup that never closed the WebSocket, so each
remount added another subscription. The socket has to be reachable from the cleanup
function, not scoped inside the connect call.

## ClubLog uploads return 403

Unresolved. The endpoint expects something the current request is missing. Everything
else about the integration works — the duplicate detection found 3,174 of them — so this
is the upload URL or a field name, not the credentials.

## The Icom decodes for a minute, then stops

Look for this in the bridge log:

    [radio] Icom audio has stopped: no packet for 20s (4189 received in total)

The radio stops sending receive audio a minute or two into a session. Nothing above
notices on its own — the decode pipeline emits windows on a timer whether or not any
audio arrived, so the liveness watchdog sees a perfectly healthy radio while it is deaf.
The symptoms are decodes that stop stacking up and a waterfall that goes strange rather
than blank, because the analyser is recomputing the same frozen samples.

DigiShack rebuilds the session automatically, in about three seconds. **Why the radio
stops is not yet understood**, so expect a brief gap in the decodes every few minutes
until it is.

If you want to confirm it yourself rather than trust a log line: watch the WebSocket and
count how many spectrum frames differ from the one before. One in 350 means a frozen
ring, which is to say no audio at all.

## The Icom has no band, no dial, and will not tune

    [radio] Icom opened but is carrying nothing useful: 0 CI-V frames, 816 audio packets

The audio is fine and the CI-V stream is stranded — which happens when the bridge is
restarted quickly and the radio is still holding the previous session. DigiShack detects
it at startup and rebuilds, twice, before carrying on with whatever works.

If it persists past two rebuilds: check the CI-V address (the log line says which one is
in use), or power-cycle the radio to release a stuck session.

## The Icom signal bar and TX power are empty

Known, unexplained, and cosmetic in the sense that decoding and transmitting are
unaffected — but it also means **SWR is not reaching the operating guards**, so the
protection that stops unattended transmission into a bad antenna is not armed on this
radio. The meter polls go out and nothing comes back, while the frequency poll on the
same stream answers every two seconds.

## Nothing on the band strip

It needs either your own decode history (so: be on a band for a few minutes) or
PSKReporter. PSKReporter is rate-limited to one query per five minutes and needs
`pskreporter.contact` set.
