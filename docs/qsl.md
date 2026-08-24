# QSL cards and email

DigiShack renders a QSL card as an image and emails it. Everything the recipient sees is
a template in [Settings](settings.md#qsl-card-and-email), not a string in the code — a
QSL card makes claims about how you operate, and those are yours to word.

## The card

Set `qsl.card.baseImage` to your own artwork (under `data/`, kept out of git — it is
your asset and it can be tens of megabytes). DigiShack composites the QSO details onto
it: a details table, your callsign, and whatever the templates say.

Position, size, colours and fonts are settings. Use **Preview** on the QSL page to see a
real card built from a real contact before sending anything.

Two things learned the hard way:

- `sharp(x).resize().metadata()` returns the **input** dimensions, not the resized ones.
  Positioning against them puts the details table thousands of pixels off-canvas.
- The card is re-rendered at send time, not when queued. A template change between
  queueing and sending should reach the card.

## Template tokens

Available in the card text, the email subject and the email body:

| Token | |
|---|---|
| `{THEIR_CALL}` | the other station's callsign |
| `{MY_CALL}` | your callsign |
| `{MY_NAME}` | your name |
| `{MY_GRID}` / `{THEIR_GRID}` | grid squares |
| `{DATE}` | QSO date, YYYY-MM-DD |
| `{TIME}` | QSO time UTC, HH:MM |
| `{DATETIME}` | both, marked UTC |
| `{YEAR}` | QSO year |
| `{BAND}` `{MODE}` `{FREQ}` | as logged |
| `{RST_SENT}` `{RST_RCVD}` | the reports |
| `{POWER}` | `qsl.txPower` |
| `{MY_QTH}` | `qsl.qth` |

A token with no value renders empty and takes its line with it, so a card for a contact
with no grid does not carry a blank "Grid:" row.

## Email

Configure SMTP in [Settings](settings.md#outgoing-email). The address is resolved from
QRZ.

**Outlook strips `white-space: pre-line`.** The email body's structure has to be in the
markup — `<p>` and `<br />` — not in CSS. This was found from a screenshot of a card
arriving as one long paragraph.

## Sending

**By hand:** the QSL page, one contact at a time, with a preview.

**Automatically:** two switches, deliberately separate.

1. `qsl.auto.enabled` — finds contacts with no QSL, resolves the address from QRZ, and
   adds them to the review queue. On its own this sends nothing.
2. `qsl.auto.approve` — sends without review.

These are unsolicited emails to other operators. A logger that mails a few hundred
strangers because one box was ticked without being understood costs its operator a
reputation and its mail server a blocklist entry. Rate limits — per day, per run,
minimum contact age, maximum contact age — are all settings.

## Emailed cards are not paper QSLs

An emailed card sets `emailQslSent`, **not** `qslSent`.

`qslSent` means a card in an envelope or a bureau. Setting it for an email makes the
contact look fully answered, so it would be skipped when working through people who sent
you a card and want one back. Those are different obligations and they need different
fields.

There is no standard ADIF field for "I emailed a card image", so it exports as
`APP_DIGISHACK_EMAILQSLSENT`. The recipient address and the exact body live on the
related `QslEmail` row — the logbook shows a badge, and the QSO detail page shows where
it went and whether it worked.
