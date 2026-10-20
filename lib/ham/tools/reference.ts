// The reference tables on the Tools page, and the filter over them.
//
// Phonetics are the ITU/ICAO alphabet with its official spellings (Alfa, Juliett) and the
// ICAO pronunciation guide, stressed syllable in capitals. RST is the ARRL's wording.

export interface RefEntry {
  term: string;
  meaning: string;
  /** Pronunciation, or the Morse for a prosign. */
  extra?: string;
}

export interface RefGroup {
  id: string;
  title: string;
  columns: readonly [string, string] | readonly [string, string, string];
  entries: readonly RefEntry[];
  /** Prosigns are written with a bar over them. */
  overline?: boolean;
}

const PHONETICS: RefEntry[] = [
  { term: "A", meaning: "Alfa", extra: "AL-fah" },
  { term: "B", meaning: "Bravo", extra: "BRAH-voh" },
  { term: "C", meaning: "Charlie", extra: "CHAR-lee" },
  { term: "D", meaning: "Delta", extra: "DELL-tah" },
  { term: "E", meaning: "Echo", extra: "ECK-oh" },
  { term: "F", meaning: "Foxtrot", extra: "FOKS-trot" },
  { term: "G", meaning: "Golf", extra: "golf" },
  { term: "H", meaning: "Hotel", extra: "hoh-TELL" },
  { term: "I", meaning: "India", extra: "IN-dee-ah" },
  { term: "J", meaning: "Juliett", extra: "JEW-lee-ett" },
  { term: "K", meaning: "Kilo", extra: "KEY-loh" },
  { term: "L", meaning: "Lima", extra: "LEE-mah" },
  { term: "M", meaning: "Mike", extra: "mike" },
  { term: "N", meaning: "November", extra: "no-VEM-ber" },
  { term: "O", meaning: "Oscar", extra: "OSS-cah" },
  { term: "P", meaning: "Papa", extra: "pah-PAH" },
  { term: "Q", meaning: "Quebec", extra: "keh-BECK" },
  { term: "R", meaning: "Romeo", extra: "ROW-me-oh" },
  { term: "S", meaning: "Sierra", extra: "see-AIR-rah" },
  { term: "T", meaning: "Tango", extra: "TANG-go" },
  { term: "U", meaning: "Uniform", extra: "YOU-nee-form" },
  { term: "V", meaning: "Victor", extra: "VIK-tah" },
  { term: "W", meaning: "Whiskey", extra: "WISS-key" },
  { term: "X", meaning: "X-ray", extra: "ECKS-ray" },
  { term: "Y", meaning: "Yankee", extra: "YANG-key" },
  { term: "Z", meaning: "Zulu", extra: "ZOO-loo" },
  { term: "0", meaning: "Zero", extra: "ZE-ro" },
  { term: "1", meaning: "One", extra: "WUN" },
  { term: "2", meaning: "Two", extra: "TOO" },
  { term: "3", meaning: "Three", extra: "TREE" },
  { term: "4", meaning: "Four", extra: "FOW-er" },
  { term: "5", meaning: "Five", extra: "FIFE" },
  { term: "6", meaning: "Six", extra: "SIX" },
  { term: "7", meaning: "Seven", extra: "SEV-en" },
  { term: "8", meaning: "Eight", extra: "AIT" },
  { term: "9", meaning: "Nine", extra: "NIN-er" },
];

const Q_CODES: RefEntry[] = [
  { term: "QRG", meaning: "Your exact frequency is … / What is my exact frequency?" },
  { term: "QRK", meaning: "The readability of your signals is … (1–5)" },
  { term: "QRL", meaning: "This frequency is in use / Is this frequency in use?" },
  { term: "QRM", meaning: "Interference from other stations" },
  { term: "QRN", meaning: "Static or atmospheric noise" },
  { term: "QRO", meaning: "Increase power; also, running high power" },
  { term: "QRP", meaning: "Decrease power; also, low-power operating (5 W or less)" },
  { term: "QRQ", meaning: "Send faster" },
  { term: "QRS", meaning: "Send more slowly" },
  { term: "QRT", meaning: "Stop sending; closing down" },
  { term: "QRU", meaning: "I have nothing for you / Have you anything for me?" },
  { term: "QRV", meaning: "I am ready / Are you ready?" },
  { term: "QRX", meaning: "Wait; stand by — I will call you again" },
  { term: "QRZ", meaning: "Who is calling me?" },
  { term: "QSB", meaning: "Your signals are fading" },
  { term: "QSK", meaning: "Full break-in: I can hear you between my signals" },
  { term: "QSL", meaning: "I acknowledge receipt; also, the card confirming a contact" },
  { term: "QSO", meaning: "A contact; I can communicate with …" },
  { term: "QSP", meaning: "I will relay to …" },
  { term: "QST", meaning: "General call to all amateurs" },
  { term: "QSX", meaning: "I am listening on … (split operation)" },
  { term: "QSY", meaning: "Change frequency; move to …" },
  { term: "QTC", meaning: "I have messages (traffic) for you" },
  { term: "QTH", meaning: "My location is … / What is your location?" },
  { term: "QTR", meaning: "The correct time is …" },
];

const PROSIGNS: RefEntry[] = [
  { term: "AR", meaning: "End of message (written +)", extra: "·−·−·" },
  { term: "AS", meaning: "Wait, stand by", extra: "·−···" },
  { term: "BK", meaning: "Break: back to you, informally", extra: "−···−·−" },
  { term: "BT", meaning: "Pause or new paragraph (written =)", extra: "−···−" },
  { term: "CL", meaning: "Closing down, not listening", extra: "−·−··−··" },
  { term: "CT", meaning: "Start of transmission (also KA)", extra: "−·−·−" },
  { term: "HH", meaning: "Error: disregard the last word", extra: "········" },
  { term: "K", meaning: "Go ahead, any station", extra: "−·−" },
  { term: "KN", meaning: "Go ahead, named station only", extra: "−·−−·" },
  { term: "R", meaning: "Received, all copied", extra: "·−·" },
  { term: "SK", meaning: "End of contact", extra: "···−·−" },
  { term: "SN", meaning: "Understood (also VE)", extra: "···−·" },
  { term: "SOS", meaning: "Distress", extra: "···−−−···" },
];

const READABILITY: RefEntry[] = [
  { term: "R1", meaning: "Unreadable" },
  { term: "R2", meaning: "Barely readable, occasional words distinguishable" },
  { term: "R3", meaning: "Readable with considerable difficulty" },
  { term: "R4", meaning: "Readable with practically no difficulty" },
  { term: "R5", meaning: "Perfectly readable" },
];

const STRENGTH: RefEntry[] = [
  { term: "S1", meaning: "Faint signals, barely perceptible" },
  { term: "S2", meaning: "Very weak signals" },
  { term: "S3", meaning: "Weak signals" },
  { term: "S4", meaning: "Fair signals" },
  { term: "S5", meaning: "Fairly good signals" },
  { term: "S6", meaning: "Good signals" },
  { term: "S7", meaning: "Moderately strong signals" },
  { term: "S8", meaning: "Strong signals" },
  { term: "S9", meaning: "Extremely strong signals" },
];

const TONE: RefEntry[] = [
  { term: "T1", meaning: "Sixty-cycle AC or less, very rough and broad" },
  { term: "T2", meaning: "Very rough AC, very harsh and broad" },
  { term: "T3", meaning: "Rough AC tone, rectified but not filtered" },
  { term: "T4", meaning: "Rough note, some trace of filtering" },
  { term: "T5", meaning: "Filtered rectified AC but strongly ripple-modulated" },
  { term: "T6", meaning: "Filtered tone, definite trace of ripple modulation" },
  { term: "T7", meaning: "Near pure tone, trace of ripple modulation" },
  { term: "T8", meaning: "Near perfect tone, slight trace of modulation" },
  { term: "T9", meaning: "Perfect tone, no trace of ripple or modulation of any kind" },
  { term: "X / C / K", meaning: "Suffixes: crystal-steady, chirp, key clicks — 599X, 579C" },
];

const ABBREVIATIONS: RefEntry[] = [
  { term: "73", meaning: "Best regards (never \"73s\")" },
  { term: "88", meaning: "Love and kisses" },
  { term: "599 / 5NN", meaning: "The contest report: readable, strong, clean (N for 9)" },
  { term: "AGN", meaning: "Again" },
  { term: "ANT", meaning: "Antenna" },
  { term: "CFM", meaning: "Confirm" },
  { term: "CQ", meaning: "Calling any station" },
  { term: "CUL", meaning: "See you later" },
  { term: "DE", meaning: "From; this is — \"W1AW DE K9XYZ\"" },
  { term: "DX", meaning: "Distance; a far-away station" },
  { term: "ES", meaning: "And" },
  { term: "FB", meaning: "Fine business: excellent" },
  { term: "GA / GE / GM / GN", meaning: "Good afternoon / evening / morning / night" },
  { term: "HI", meaning: "Laughter" },
  { term: "HR", meaning: "Here" },
  { term: "HW?", meaning: "How do you copy?" },
  { term: "NR", meaning: "Number" },
  { term: "OM", meaning: "Old man: any male operator" },
  { term: "OP", meaning: "Operator" },
  { term: "PSE", meaning: "Please" },
  { term: "PWR", meaning: "Power" },
  { term: "QRZ?", meaning: "Who is calling me?" },
  { term: "RIG", meaning: "The station's radio" },
  { term: "RPT", meaning: "Repeat; also, report" },
  { term: "RST", meaning: "Readability, strength, tone report" },
  { term: "SRI", meaning: "Sorry" },
  { term: "TNX / TU", meaning: "Thanks / thank you" },
  { term: "UR", meaning: "Your; you are" },
  { term: "WX", meaning: "Weather" },
  { term: "XYL", meaning: "Wife" },
  { term: "YL", meaning: "Young lady: any female operator" },
];

export const REFERENCE_GROUPS: readonly RefGroup[] = [
  { id: "ref-phonetics", title: "Phonetic alphabet", columns: ["", "Word", "Say it"], entries: PHONETICS },
  { id: "ref-q", title: "Q-codes", columns: ["Code", "Meaning"], entries: Q_CODES },
  { id: "ref-prosigns", title: "CW prosigns", columns: ["Prosign", "Meaning", "Morse"], entries: PROSIGNS, overline: true },
  { id: "ref-rst-r", title: "RST — readability", columns: ["", "Meaning"], entries: READABILITY },
  { id: "ref-rst-s", title: "RST — strength", columns: ["", "Meaning"], entries: STRENGTH },
  { id: "ref-rst-t", title: "RST — tone (CW)", columns: ["", "Meaning"], entries: TONE },
  { id: "ref-abbr", title: "Abbreviations", columns: ["", "Meaning"], entries: ABBREVIATIONS },
];

/**
 * The groups with only the entries matching a query, case-insensitively, across term,
 * meaning and pronunciation. Entries whose TERM matches come first, so "K" finds Kilo and
 * the prosign K before every meaning that happens to contain a k.
 */
export function filterReference(query: string): { group: RefGroup; entries: RefEntry[] }[] {
  const q = query.trim().toLowerCase();
  return REFERENCE_GROUPS.map((group) => {
    if (!q) return { group, entries: [...group.entries] };
    const rank = (e: RefEntry): number => {
      const t = e.term.toLowerCase();
      if (t === q || t.split(/\s*\/\s*/).includes(q)) return 0;
      if (t.startsWith(q) || e.meaning.toLowerCase() === q) return 1;
      if (t.includes(q) || e.meaning.toLowerCase().includes(q) || (e.extra ?? "").toLowerCase().includes(q)) {
        return 2;
      }
      return 3;
    };
    const entries = group.entries
      .map((e, i) => ({ e, i, r: rank(e) }))
      .filter((x) => x.r < 3)
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.e);
    return { group, entries };
  }).filter((g) => g.entries.length > 0);
}
