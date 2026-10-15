// CW - the Morse code, its timing, and a keyed-tone waveform for the checks.
//
// MORSE IS TIMING. A dit is the unit; a dah is three; the gap inside a character is one,
// between characters three, between words seven. The PARIS convention makes "PARIS " fifty
// units, so at W words per minute a dit is 1200 / W milliseconds: 60 ms at 20 WPM, 40 ms
// at 30. Nothing else is standardised - no start bit, no sync, no checksum - which is why
// a decoder's whole problem is deciding how long a dit is right now, and why the one in
// lib/digital/cwdemod.ts spends its effort there.
//
// THE TABLE is ITU-R M.1677: the letters, the digits, the punctuation that has a code, and
// the prosigns operators actually send - AR (end of message), SK (end of contact), BT (the
// "=" break), KN (go ahead, named station only), AS (wait), and the eight-dit error. A
// prosign is two letters run together with no gap, which is why it has its own pattern.
//
// SENDING, on this station, is the FlexRadio's own CWX keyer: the radio is handed text
// and keys itself at a speed, with its own rise times, and this module is not involved.
// The waveform here exists so the decoder can be checked against known keying at known
// speeds - raised-cosine edges of a few milliseconds, as a real keyer shapes them, so the
// test signal is neither cleaner nor dirtier than the air.

/** Milliseconds per dit at a speed, by the PARIS convention. */
export function ditMsFor(wpm: number): number {
  return 1200 / wpm;
}

/** Words per minute for a dit length. */
export function wpmFor(ditMs: number): number {
  return 1200 / ditMs;
}

/** Character to pattern, "." and "-". Prosigns are written in angle brackets: "<AR>". */
export const MORSE: Readonly<Record<string, string>> = {
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
  "0": "-----",
  "1": ".----",
  "2": "..---",
  "3": "...--",
  "4": "....-",
  "5": ".....",
  "6": "-....",
  "7": "--...",
  "8": "---..",
  "9": "----.",
  ".": ".-.-.-",
  ",": "--..--",
  "?": "..--..",
  "'": ".----.",
  "!": "-.-.--",
  "/": "-..-.",
  "(": "-.--.",
  ")": "-.--.-",
  "&": ".-...",
  ":": "---...",
  ";": "-.-.-.",
  "=": "-...-",
  "+": ".-.-.",
  "-": "-....-",
  _: "..--.-",
  '"': ".-..-.",
  $: "...-..-",
  "@": ".--.-.",
  "<AR>": ".-.-.",
  "<SK>": "...-.-",
  "<BT>": "-...-",
  "<KN>": "-.--.",
  "<AS>": ".-...",
  "<HH>": "........",
};

/**
 * Pattern to character. Where two names share a pattern the plain character wins for
 * display (= over <BT>, + over <AR>, ( over <KN>, & over <AS>): that is how operators read
 * them, and the prosign meaning is clear from where it falls in a contact.
 */
export const MORSE_BY_PATTERN: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [ch, pat] of Object.entries(MORSE)) {
    if (!(pat in out) || !ch.startsWith("<")) out[pat] = ch;
  }
  return out;
})();

/** The pattern for one character or prosign, or null. Case-insensitive. */
export function morseFor(ch: string): string | null {
  return MORSE[ch.toUpperCase()] ?? null;
}

/** The character for a pattern, or null. */
export function charForPattern(pattern: string): string | null {
  return MORSE_BY_PATTERN[pattern] ?? null;
}

/**
 * Text to keying: a list of on/off runs in dit units. Prosigns in angle brackets are sent
 * as one character; characters with no code are dropped; a space is a word gap. The
 * result ends with the last element, not a trailing gap.
 */
export function cwKeying(text: string): { on: boolean; units: number }[] {
  const runs: { on: boolean; units: number }[] = [];
  const tokens = tokenise(text.toUpperCase());
  let pendingGap = 0;
  for (const t of tokens) {
    if (t === " ") {
      pendingGap = 7;
      continue;
    }
    const pat = MORSE[t];
    if (!pat) continue;
    if (runs.length > 0) runs.push({ on: false, units: Math.max(pendingGap, 3) });
    pendingGap = 0;
    for (let i = 0; i < pat.length; i++) {
      if (i > 0) runs.push({ on: false, units: 1 });
      runs.push({ on: true, units: pat[i] === "-" ? 3 : 1 });
    }
  }
  return runs;
}

/** Split text into characters, prosigns ("<AR>") and single spaces (runs of spaces collapse). */
function tokenise(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "<") {
      const j = text.indexOf(">", i);
      if (j > i) {
        out.push(text.slice(i, j + 1));
        i = j + 1;
        continue;
      }
    }
    if (/\s/.test(c)) {
      if (out.length > 0 && out[out.length - 1] !== " ") out.push(" ");
      i++;
      continue;
    }
    out.push(c);
    i++;
  }
  while (out.length > 0 && out[out.length - 1] === " ") out.pop();
  return out;
}

/** How long a text takes to send at a speed, ms, with a word gap after it (the PARIS measure). */
export function cwDurationMs(text: string, wpm: number): number {
  const dit = ditMsFor(wpm);
  let units = 7;
  for (const r of cwKeying(text)) units += r.units;
  return units * dit;
}

export interface CwWaveformOptions {
  sampleRate: number;
  wpm: number;
  /** Tone frequency, Hz audio. Default 600. */
  pitchHz?: number;
  amplitude?: number;
  /** Keying edge, ms, raised-cosine. Default 5, a typical keyer. */
  riseMs?: number;
  /** Silence before the first element, ms. Default 100. */
  leadMs?: number;
}

/**
 * A keyed tone for a text: the timing above, with raised-cosine edges so the test signal
 * has the bandwidth of a real transmission rather than the clicks of a hard switch.
 * Ends with a word gap of silence, as the duration function counts.
 */
export function cwWaveform(text: string, opts: CwWaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const pitch = opts.pitchHz ?? 600;
  const amp = opts.amplitude ?? 1;
  const dit = ditMsFor(opts.wpm) / 1000;
  const rise = Math.max(1, Math.round(((opts.riseMs ?? 5) / 1000) * fs));
  const lead = Math.round(((opts.leadMs ?? 100) / 1000) * fs);
  const runs = cwKeying(text);
  let totalUnits = 7;
  for (const r of runs) totalUnits += r.units;
  const total = lead + Math.round(totalUnits * dit * fs);
  const out = new Float32Array(total);
  let phase = 0;
  const dphi = (2 * Math.PI * pitch) / fs;
  let n = lead;
  let unitPos = 0;
  for (const r of runs) {
    const start = n;
    unitPos += r.units;
    const end = Math.min(total, lead + Math.round(unitPos * dit * fs));
    if (r.on) {
      const len = end - start;
      for (let i = 0; i < len; i++) {
        // Raised-cosine edges inside the element's own time, as a keyer shapes them.
        let g = 1;
        if (i < rise) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / rise);
        else if (len - 1 - i < rise) g = 0.5 - 0.5 * Math.cos((Math.PI * (len - 1 - i)) / rise);
        out[start + i] = amp * g * Math.sin(phase);
        phase += dphi;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    } else {
      // Keep the oscillator running through the gap so the next element starts in phase.
      phase = (phase + dphi * (end - start)) % (2 * Math.PI);
    }
    n = end;
  }
  return out;
}
