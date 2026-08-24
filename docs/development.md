# Development

```bash
npm run dev        # Next.js on :3000
npm run bridge     # the radio process on :3101
npm run check      # typecheck + every test
```

`npm run check` is the gate. It runs `tsc --noEmit` and then every `scripts/check-*.ts`
in sequence, failing on the first one that exits non-zero.

## The test suite

| Script | Covers |
|---|---|
| `check:time` | UTC formatting, and re-runs itself under +14 and −11 to prove independence |
| `check:validation` | Zod schemas, including the `z.coerce.boolean("0") === true` trap |
| `check:adif` | Writer/parser round trip, byte-length fields, multi-byte values |
| `check:dxcc` | Callsign → entity across 340 entities, portable prefixes, the KG4 rule |
| `check:wsjtx` | The WSJT-X UDP protocol codec |
| `check:tx` | Transmit framing and the DAX packet format |
| `check:qso` | The QSO state machine and the operating guards |
| `check:worth` | Award-aware candidate ranking |
| `check:ft2` | FT2 end to end — 219 assertions, encoder against decoder |
| `check:pskreporter` | Query shaping and response parsing |
| `check:qsl` | Templates, tokens, line handling |
| `check:pota-chase` | The auto-operator's chase logic, through fake radio plumbing |
| `check:pota-merge` | Matching POTA's logbook to existing contacts |
| `check:pota-refs` | Asserts across the live database that the two reference representations agree |
| `check:upload-state` | Upload tracking for the write-only services |
| `check:backup` | SQL literals, statement splitting, tar pack/unpack |
| `check:restore` | **Not in `npm run check`.** Real backup → scratch database → compare |
| `check:operating` | The whole operating layer against fakes — and the same session run twice, once with FlexRadio-shaped dependencies and once with Icom-shaped ones, which must produce identical transmissions |
| `check:pipeline` | The decode pipeline, golden, against known audio |
| `check:flex-wiring` | The FlexRadio driver's glue to that pipeline — written because extracting the pipeline left it with no coverage at all |
| `check:icom` | Icom packets and passcode, including a real captured ping exchange |
| `check:icom-stream` | The control stream against a stub radio, including the session release |
| `check:icom-io` | The serial and audio streams |
| `check:icom-rig` | All three assembled, and "open is not the same as carrying" |
| `check:icom-tx` | Icom transmit — mostly about refusing to |
| `check:civ` | CI-V framing, BCD, meter calibration, the ATU, forward power |
| `check:transmit-gate` | That each radio's transmit switch is its own and inherits nothing |
| `check:decode-log` | The per-UTC-day decode CSV, against a real temporary directory |
| `check:sntp` | SNTP packets and the clock correction — offline, with `--live` for one real exchange |
| `check:watchdog` | The liveness watchdog's timing |
| `check:schedule` | The operating schedule and PA duty tracking |
| `check:settings-tabs` | That every settings group lands on a tab and none can go missing |
| `check:docs` | That `docs/settings.md` still matches the registry |
| `check:contrast` | Colour contrast in the theme |
| `check:cloudlog` | Cloudlog/Wavelog API shaping |

There is no framework. Each script prints `ok` / `FAIL` lines and exits non-zero. The
hard problems here are numerical and protocol-shaped — LDPC decoding, tar checksums,
prefix matching, SQL escaping — and what those need is many assertions with the
reasoning written beside them.

### Two rules about tests, both learned by breaking them

**A test that cannot fail is worth nothing.** This project has shipped two: an LDPC
fixture whose `(t*37 + i*13) % 2` reduced to `t % 2` and produced exactly the expected
count by accident, and a DXCC check that reimplemented the scorer and asserted
`F/K9XYZ → France` while production returned USA. When a test is guarding something
subtle, break the code on purpose and confirm the test notices.

**Test the shipped path, not a copy of it.** `check-pota-chase.ts` drives the real
`AutoOperator` through fake radio plumbing rather than reimplementing its scheduling.
The reimplementation is what passes while production is wrong.

## Conventions

**Pages Router only.** There is no `app/` directory. Do not add one.

**TypeScript strict, with `noUncheckedIndexedAccess`.** `arr[0]` is `T | undefined` and
the compiler will make you deal with it.

**Settings, not constants.** Anything an operator might reasonably want to change goes
in `lib/settings/registry.ts`. After adding one:

```bash
npx tsx scripts/gen-docs-settings.ts
```

`docs/settings.md` is generated from that array, and `npm run check` fails when they
disagree — so a new setting without documentation fails the build.

**Comments explain why, not what.** The codebase is dense with reasoning about
decisions that look wrong until you know the constraint: why `client gui` is mandatory,
why band beats time when matching a park, why the checksum field counts as spaces. Keep
that up. Comments that restate the code are noise; comments that record a constraint
save the next person a day.

**Every displayed time goes through `lib/time.ts`** and carries a UTC marker.

## Adding a database column

```bash
npx prisma migrate dev --name what_it_does
```

Then stop the web app and the bridge before `npx prisma generate` — both hold the query
engine and the rename fails with `EPERM` otherwise.

Remember the read paths: `QSO_INCLUDE` in `lib/db/qso.ts` decides what every QSO
response carries, and the ADIF writer, parser, export route, import service, validation
schema, form and client type all need the field too. Missing one shows up as data that
saves and silently does not come back.

## Windows notes

Development happens on Windows, so:

- The Bash tool eats backslashes in heredocs. Write scripts to a file instead.
- `mysqldump` and `mysql` are not on PATH, which is why the backup is pure Node.
- MariaDB folds table names to lower case. This matters when moving to Linux — see
  [Backup](backup-and-moving.md#the-linux-trap).

## Releasing

Every change gets a version bump, a CHANGELOG entry, a commit and a push. The CHANGELOG
is written for someone deciding whether to upgrade and for whoever has to understand
the decision later: what changed, what broke, and what was learned. Several entries
record being wrong, which is the point of keeping it.
