// The receive noise floor, per band.
//
// Why this matters enough to track: a station can transmit perfectly and hear almost
// nothing, and no other measurement tells you that. Observed live on this station —
// 114 receivers reported hearing its 100 W on 20 m while it was decoding under two
// signals a cycle, with the noise floor sitting at −80 dBm. The transmitter was fine.
// The band was not deaf. The receiver was buried.
//
// Kept as a MEDIAN of recent samples rather than a mean or a peak. Every real signal
// on the band is an excursion above the floor, and FT8 is a band full of them — a
// mean would drift up with activity and a peak would just track the loudest station,
// so both would report a busy band as a noisy one, which is the opposite of useful.

/** Samples to keep. At roughly 4/s this is about a minute of history. */
const WINDOW = 240;

export class NoiseFloor {
  private samples: number[] = [];

  /**
   * Feed one S-meter reading, in dBm.
   *
   * ONLY on receive. A reading taken while transmitting is measuring our own
   * transmitter, which would report every active station as a noisy location.
   */
  sample(dbm: number | null | undefined): void {
    if (dbm === null || dbm === undefined || !Number.isFinite(dbm)) return;
    // A receiver reading above this is not measuring a noise floor — it is
    // measuring a signal, or a meter that has come unstuck.
    if (dbm > 0 || dbm < -180) return;
    this.samples.push(dbm);
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  /** The floor, or null until there is enough to be worth quoting. */
  dbm(): number | null {
    if (this.samples.length < 20) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  reset(): void {
    this.samples = [];
  }
}
