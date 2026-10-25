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

## Sending through Microsoft 365

Settings → QSL → Outgoing email → **Send mail through** chooses the service for everything
DigiShack sends: QSL cards, alerts, password resets. SMTP is the default and is what every
install used before the choice existed. **Microsoft 365 app (Graph)** sends as the mailbox
named under *Microsoft 365 mail app*, through an app registration with the `Mail.Send`
application permission.

The message is built exactly as it would be for SMTP and handed to Graph as MIME, so the
card attachment, its Content-ID and the `List-Unsubscribe` header are identical on both
routes. Graph caps one send at about 4 MB once encoded; a larger message is refused with a
sentence rather than by Microsoft. The Integrations page has **Send a test message**, which
mails the station's own alerts address and nobody else.

## Received cards

Settings → QSL → *Received cards (email)* reads the station mailbox (Inbox and Junk, with
`Mail.Read`) for cards other operators send you, and links each to the contact it confirms.
Nothing in the mailbox is marked or deleted. Nothing is moved either, unless *Move imported
mail to folder* names one (e.g. `DigiShack`): then the cards, replies, notices and bounces
an import recorded are moved there from Inbox and Junk, which needs `Mail.ReadWrite` on the
app. QSL → **Received** shows the
cards, replies, items to review, notices and bounces, with **Import now** and **Test
connection**.

- **Your own cards are skipped** — mail from the mailbox itself, from any address the
  station sends from, or with your card's own subject (`QSL Confirmation for X / <your call>
  QSO`). Their bounces are recorded against the contact and never counted as received.
- **Matching**: a card whose filename or email carries a time (`K9XYZ_20261023_1838_20M_FT4.jpg`,
  or `Date: 20261023` / `Time: 183800 UTC` / `Band: 20m` lines in the message) matches a
  contact within ten minutes on the same band and mode; a date alone matches the one contact
  near it; a reply matches the contact your card was about, and when several cards went to
  that station, the details of yours quoted in the reply pick which. Anything less certain is
  left for you to assign or dismiss — a wrong match is worse than none.
- **Pictures** are kept under `data/qsl-received/` (so backups include them), accepted only
  when the bytes are JPEG, PNG, GIF or WebP, and never over 10 MB.
- **Notices** keep their link. A digiqsl.com card page is read for the contact it confirms
  (sender, date, time, band, mode); the site draws the card in the browser, so there is no
  picture to keep, and a page made out to you counts as their card. qslworld.com notices
  carry the contact in their links (`from`, `to`, `band`, `mode`, `date`, `time`), which is read
  without opening the page; a link made out to you counts as their card, and pictures are
  fetched when the page exposes them. eQSL cards need your eQSL login and come in through the
  eQSL inbox sync instead.
- A matched card sets the contact's **emailed card received** flag. It is not a paper card,
  not LoTW, and not award credit, so the awards page and everything uploaded are unchanged.

IMAP and Gmail / Google Workspace are listed in the settings and come in the next release.
