# WEFAX (HF weather fax)

Receiving the weather charts that coast stations send to ships: what they are, where to
tune, what the receiver does with them, and how far it can be pushed. The receiver follows
fldigi 4.2.13 (`src/wefax/wefax.cxx`), with the changes listed at the end.

WEFAX is receive-only. Met services send it; ships print it. Amateurs do not transmit it,
and DigiShack has no transmitter for it. (The code has a test signal generator, used only
to check the receiver.)

## On the decodes page

Put the radio on the station first (USB, the dial 1.9 kHz below the published frequency),
then choose **WEFAX** in the mode list. It decodes where the dial is (marked "here") and stays
chosen while the dial stays within 5 kHz. The picture panel draws each chart as it comes in,
row by row, from the start tone to the stop tone; the decoder takes IOC 576 or 288 from the
start tone, the line rate from the phasing, and straightens a slanted chart by itself. The
centre is 1900 Hz; a click on the waterfall moves it.

Each finished chart is saved with the SSTV pictures and shows in the same gallery. WEFAX is
listen-only: there is nothing to send and nothing to log, and the radio is never keyed in it.

## What it is

Radiofax sends one long black-and-white picture a line at a time, as a frequency: 1500 Hz
is black, 2300 Hz is white - a carrier at 1900 Hz swung 400 Hz either way. Most stations
send 120 lines a minute, so a typical chart of 800 to 1200 lines takes 7 to 10 minutes. The
US Coast Guard, on behalf of the National Weather Service, sends surface analyses and
forecasts, wind and wave charts, satellite pictures and tropical charts around the clock
on a published schedule; Canada, the UK, Germany, Japan, Australia and others do the same.

A transmission goes:

| Part | How long | What it is |
|------|---------:|------------|
| Start tone | 5 s | The carrier switched black-white 300 times a second (675 for the old IOC 288 charts). Tells the receiver a chart is coming, and which kind. |
| Phasing | about 30 s | Black lines with a narrow white pulse at the line boundary. The receiver times the pulses to find where each line starts and how long a line is. |
| The chart | minutes | Line after line. |
| Stop tone | 5 s | Switched black-white 450 times a second. |

The **IOC** (index of cooperation) sets the chart's proportions: a line is pi x IOC pixels
wide. Almost everything is IOC 576 (1809 pixels a line); IOC 288 (904 pixels) is rare now.

## Tuning

The receiver expects the signal **centred on 1900 Hz audio**, as fldigi does: black at
1500 Hz, white at 2300 Hz. Radiofax schedules list the **assigned (centre) frequency**,
so on **USB** set the dial **1.9 kHz below** the published frequency:

    dial (USB) = published frequency - 1.9 kHz

On the waterfall a chart in progress fills 1500 to 2300 Hz, brightest at the edges (black
and white are the commonest levels). The phasing shows as a strong line at 1500 Hz; the
start and stop tones as a smear across the whole 800 Hz.

Tune carefully: there is no automatic frequency correction, and the frequency is the
grey level. 25 Hz off moves every grey by about 8 levels (of 255); 100 Hz off turns light
greys white and dark greys black. Use a filter at least 1 kHz wide around 1900 Hz, AGC
on, and no noise reduction or audio processing - it bends the tones.

### Stations

North American stations, from the National Weather Service's *Worldwide Marine
Radiofacsimile Broadcast Schedules*. Schedules and frequencies do change: check the current
edition (weather.gov/marine, "Radiofax") before relying on these, and its times for what is
sent when.

| Station | Where | Published (kHz) | Dial, USB (kHz) |
|---------|-------|-----------------|-----------------|
| NMF | Boston (Marshfield), MA | 4235, 6340.5, 9110, 12750 | 4233.1, 6338.6, 9108.1, 12748.1 |
| NMG | New Orleans, LA | 4317.9, 8503.9, 12789.9, 17146.4 | 4316.0, 8502.0, 12788.0, 17144.5 |
| NMC | Point Reyes, CA | 4346, 8682, 12786, 17151.2, 22527 | 4344.1, 8680.1, 12784.1, 17149.3, 22525.1 |
| NOJ | Kodiak, AK | 2054, 4298, 8459, 12412.5 | 2052.1, 4296.1, 8457.1, 12410.6 |

Which band works depends on the time of day and the distance, as for any HF signal: the 4
and 6 MHz channels at night and over a few hundred miles, 8 and 12 MHz by day or further
out, 17 and 22 MHz for long daytime paths. From the Midwest, Boston and New Orleans on 8 or
12 MHz in daytime are the usual first catches. The schedules give each broadcast's start
time; a chart begins with its start tone on the minute.

Other stations - Halifax and Iqaluit (Canada), Northwood (UK), Hamburg/Pinneberg
(Germany), Tokyo, Charleville and Wiluna (Australia) and more - are in the same NWS
publication and in the national services' own lists.

## What the receiver does

It waits for a start tone. On one, it knows the IOC (300 Hz means 576, 675 Hz means 288)
and looks for phasing lines; from them it takes the lines per minute (240, 120, 90 or 60),
where each line starts, and how long a line really is in your sound card's samples. The
picture then builds up a row at a time, 1809 pixels wide for IOC 576, until the stop tone.

- **Tuned in late, during the phasing?** Eight phasing lines start a picture without the
  start tone. Tuned in during the chart itself, nothing starts until the next chart.
- **Start tone but no phasing?** After twelve seconds the picture starts anyway, at 120
  lines a minute, with its left edge wherever it happens to fall (usually off to one side;
  the picture is still readable, wrapped round).
- **The picture ends** on the stop tone; on a new start tone or new phasing (a station
  going straight on to the next chart); after 3000 rows (25 minutes at 120 LPM); after ten
  seconds of silence; or when the rows stop resembling each other for 40 rows - the station
  went off without a stop tone and this is noise. The tail end of the stop tone, which would
  otherwise show as grey hash at the bottom, is trimmed off.

### Slant

A sound card whose clock is a little fast or slow makes every line a little long or short,
and the picture leans: 200 ppm is about 0.36 pixels a line, 145 pixels over 400 lines.
The receiver measures the true line length from the phasing lines - twenty of them pin it
to about 1 ppm - and corrects for it, so the picture comes out straight without setting
anything. For a chart received without phasing there is a manual correction in parts per
million (`slantPpm`), fldigi's slant control; measure it once on a chart with phasing and
it stays right for that sound card.

### How far it goes

From scripts/check-wefax.ts, on a generated test chart (noise measured in 2500 Hz):

| Signal to noise | Correlation with the original | Notes |
|---:|---:|---|
| 20 dB | 0.99 | clean |
| 10 dB | 0.97 | speckled, every line readable |
| 5 dB | 0.94 | grainy; the tones and phasing still found |

Sixty seconds of noise starts no picture, and neither does silence.

## Differences from fldigi

- **Both IOCs at once.** fldigi has a mode for each (WEFAX-576, WEFAX-288); this listens for
  both start tones and takes the IOC from the one it hears.
- **Automatic slant** from the phasing lines. fldigi has only the manual control, and its
  line length is rounded to whole samples (5512 at 11025 Hz instead of 5512.5, itself a 90
  ppm lean that the manual control is there to take out).
- **Phasing timed to a fraction of a sample**, by a straight line fitted through all the
  phasing pulses rather than starting after the fourth; the LPM is measured, not taken from
  a setting. Inverted phasing (black pulse on white) is accepted too.
- **The APT tones** are found on a wider filter than the picture's (fldigi uses the picture's,
  whose default "Narrow" setting all but hides the 675 Hz IOC 288 tone), and the transitions
  must be regular as well as at the right rate, so noise does not start pictures.
- **Not ported**: fldigi's AFC, its manual mode, its horizontal auto-centring on the blank
  margin (the phasing does that job), its noise-removal and binary display options, and its
  rules for discarding pictures it judges blank or garbage - every picture is handed over.
- **fldigi's own transmitter** sends the start and stop "tones" as plain audio tones at
  300/675/450 Hz rather than as the carrier keyed black-white; DigiShack does not transmit
  WEFAX, and its test generator sends them the way stations do.

## For developers

`lib/digital/wefax.ts` has the parameters (with fldigi file and line references), the picture
geometry, a test chart and the test signal generator (`wefaxWaveform`, a test generator
only). `lib/digital/wefaxdemod.ts` is the receiver, `WefaxDecoder`, shaped like the SSTV
decoder for the decode pipeline: `new WefaxDecoder(sampleRate, { onStart, onRows, onImage,
onStop }, options?)`, `feed(samples)`, `reset()`, `statistics`. Checks: `npx tsx
scripts/check-wefax.ts`.
