# Backlog

**Moved to the issue tracker: https://github.com/W9MDM/DigiShack/issues**

This file was an interim home. It existed for one release, because the tracker was enabled
but the API token could read issues and not create them, and the alternative was carrying
the list in conversation — which is how it reached fourteen items with three of them raised
twice.

All eleven open items are now issues, with their evidence intact. Nothing was summarised
away in the move: the measured timings, the counts, the callsign lists and the disproved
theories are in the issue bodies, because those are the parts that stop the same wrong
conclusion being reached a second time.

## Labels

| label | meaning |
|---|---|
| `answering` | the FT8/FT4 sequencer, decoding, getting a reply out on time |
| `uploads` | LoTW, QRZ, eQSL, Club Log, Cloudlog, N3FJP |
| `radio` | Flex and Icom control, DAX audio, the panadapter |
| `housekeeping` | repository, tooling and process; nothing an operator sees |
| `bug` | behaviour that is wrong, with evidence |
| `performance` | works correctly, wastes margin |
| `needs-decision` | blocked on a judgement call, not on effort |
| `unverified` | reasoned but never exercised against real hardware or a real fault |
| `destructive` | irreversible; requires an explicit go-ahead before it is even attempted |

`needs-decision` and `unverified` are the two that earn their place. Four of the eleven
issues cannot be worked on by picking them up — they are waiting on a choice about what
SHOULD happen, and treating them as ordinary work means guessing at it. `unverified` marks
a fix that is reasoned rather than measured, which in a project talking to radios is a
distinction that has been load-bearing more than once.

## Filing new ones

The API wants label **IDs**, not names — posting `"labels": ["bug"]` is rejected with
`cannot unmarshal JSON string into Go int64`. Read them from
`/api/v1/repos/PCARC/DigiSHACK/labels` first.

Write the evidence into the issue, not a title and a shrug. Every item here that turned out
to be worth keeping was worth keeping because of a number attached to it.
