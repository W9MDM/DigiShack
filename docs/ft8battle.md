# FT8 Battle Royale

[ft8battle.com](https://ft8battle.com/) scores FT8/FT4 contacts against other players over a
UTC day. DigiShack plays it as a **view and a broadcast, not an operating mode** — their
rules ban automated operation outright ("auto-CQ bots, or any program that makes QSOs
without operator interaction"), detected automatically, with a permanent ban. So BR mode
changes what the decodes page shows and where logged contacts are reported, and nothing
about what the station does on the air. The page says so, loudly, whenever the auto
operator is running with BR mode on.

## BR mode

One switch — on the decodes page next to **UDP**, or under Settings → Spotting & broadcast → FT8 Battle
Royale. Operators switch it; everyone sees it. While it is on:

- **The decode list is ranked by points** — what each station on the waterfall would be
  worth, with the duplicate penalty shown in red where working them again would *cost*
  twice what it earned.
- **Every logged contact is sent to the Battle Royale server** as the WSJT-X datagram it
  expects, with its own program id, comment and extra fields. Off, nothing is sent there.
- **The bridge tracks their activity feed** and the page shows the last two hours of it:
  who worked whom, on what band and mode, for how much, and every steal.

## What the score can and cannot know

Their arithmetic, in their order:

    (base 1 + POTA 2 + First Contact 4) × band (6 m/10 m 1.5) × mode (FT4/FT2 2) × Happy Hour 2

Computable here: everything on that line, and the duplicate penalty from our own log. Two
things live on their server:

- **First Contact (+4)** goes to the first player to work a station on a *band* today.
- **Stealing** — "last person to work the same station on the same band AND mode on the
  same day gets ALL the points." The thief takes what the holder earned, bonuses included,
  and chain steals pay out the accumulated total. Working a station you already hold is a
  duplicate, not a steal.

Without the feed both are unknown and the score is a **range** (`4–24`). With the feed,
for every station it has seen today:

- **Claimed on this band** → nobody can be first; the range collapses to its floor.
- **Held by another player on this band and mode** → a steal: their points are added to
  ours, shown as `🔥 11` and `STEAL from KC3LVG +6` in the column's tooltip. Where the
  feed showed the holder but not the points (the predictor list), the steal is a range from
  their base alone to base plus First Contact.

What it still cannot see: stations worked before the tracker started, contacts outside
the published window, POTA bonuses on the other side, and the ATH Happy Hour.

## The tracker

ft8battle.com publishes its front end's data as plain JSON — `data/activity.json`, the
last fifty events, is what their QSO ticker overlay polls every ten seconds — and its Steal
Predictor page embeds the last couple of hours of contacts with the mode and current holder.
The bridge polls the feed every 20 s while BR mode is on and every 60 s while it is off,
reads the predictor once at start to seed the window, and keeps two days of events in the
database (`Ft8brActivity`) so a bridge restart does not empty the picture. It identifies
itself as DigiShack, reads only, and never calls anybody.

`/api/contest/ft8battle?hours=2` answers with the events of the last N hours and the
holdings derived from the whole UTC day.

## The broadcast

Settings → Spotting & broadcast → FT8 Battle Royale holds the server address and port they publish and
the identity of the ADIF document. The preview panel under it shows exactly what leaves the
station, field by field, built through the same code that sends it. It is separate from
**Broadcast logged contacts (UDP)**, which feeds GridTracker, Log4OM, JTAlert or N1MM on
your own network and has its own switch.
