// Turns what a caller says ("after 40 minutes", "tomorrow 5 pm", "next Monday
// evening", "18 October at 11") into an exact instant.
//
// The voice agent's LLM does not reliably know the current date or do clock
// arithmetic, so it sends the caller's words through verbatim and this module
// does the maths — deterministically, in India Standard Time (UTC+5:30, no DST).

const IST_OFFSET_MIN = 330;

export interface ParsedWhen {
  /** The resolved instant. */
  at: Date;
  /** "Saturday, 18 October 2026 at 5:00 PM IST" — safe to read back to the caller. */
  spoken: string;
  /** True when the caller gave no clock time and `defaultHour` was used. */
  timeAssumed: boolean;
}

export type WhenError = "empty" | "unparseable" | "time_missing" | "in_past";

export interface ParseWhenOptions {
  now?: Date;
  /** Hour (0-23, IST) to use when the caller names a day but no time. Omit to require a time. */
  defaultHour?: number;
}

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty five": 45, "forty-five": 45,
  fortyfive: 45, fifty: 50, sixty: 60, ninety: 90,
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
];

// IST wall-clock fields for an instant.
function istParts(d: Date) {
  const s = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  return {
    y: s.getUTCFullYear(), mo: s.getUTCMonth(), d: s.getUTCDate(),
    h: s.getUTCHours(), mi: s.getUTCMinutes(), wd: s.getUTCDay(),
  };
}

// The instant for an IST wall-clock time.
function fromIst(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo, d, h, mi) - IST_OFFSET_MIN * 60000);
}

export function formatIst(d: Date): string {
  const text = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d);
  // en-IN renders "Saturday, 18 October 2026 at 5:00 pm" — normalise to upper-case AM/PM.
  return `${text.replace(/\b(am|pm)\b/i, (m) => m.toUpperCase())} IST`;
}

function numberFrom(token: string): number | null {
  const t = token.trim().toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return NUM_WORDS[t] ?? null;
}

/** "in 40 minutes", "after half an hour", "within 2 hrs", "after one day". */
function parseRelative(text: string, now: Date): Date | null {
  if (/\b(half an hour|half hour|aadha ghanta)\b/.test(text)) return new Date(now.getTime() + 30 * 60000);
  if (/\bquarter of an hour\b|\ba quarter hour\b/.test(text)) return new Date(now.getTime() + 15 * 60000);
  if (/\ban hour and a half\b|\bone and a half hours?\b|\bdeed ghanta\b/.test(text)) return new Date(now.getTime() + 90 * 60000);

  const re =
    /\b(?:in|after|within|about|around|another|next)?\s*(\d+(?:\.\d+)?|forty[ -]?five|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/;
  const m = text.match(re);
  if (!m) return null;
  // A bare "a"/"an" only means a quantity when a relative cue precedes it ("in an hour").
  if ((m[1] === "a" || m[1] === "an") && !/\b(in|after|within|another)\s+an?\s/.test(text)) return null;
  const qty = m[1].includes(".") ? parseFloat(m[1]) : numberFrom(m[1]);
  if (qty == null || !Number.isFinite(qty)) return null;
  const unit = m[2][0];
  const minutes = unit === "m" ? qty : unit === "h" ? qty * 60 : unit === "d" ? qty * 1440 : qty * 10080;
  return new Date(now.getTime() + minutes * 60000);
}

interface Clock { h: number; mi: number; assumed?: boolean }

/** Pull a clock time out of free text. Returns null when none is stated. */
function parseClock(text: string): Clock | null {
  if (/\bnoon\b|\bmidday\b/.test(text)) return { h: 12, mi: 0 };
  if (/\bmidnight\b/.test(text)) return { h: 0, mi: 0 };

  // 5 pm, 5:30 pm, 5.30pm, 5 p.m.
  let m = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\b\.?/);
  if (m) {
    let h = parseInt(m[1], 10);
    const mi = m[2] ? parseInt(m[2], 10) : 0;
    if (h < 1 || h > 12 || mi > 59) return null;
    if (m[3] === "p" && h !== 12) h += 12;
    if (m[3] === "a" && h === 12) h = 0;
    return { h, mi };
  }
  // 17:00, 17.30, 09:15
  m = text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (m) return { h: parseInt(m[1], 10), mi: parseInt(m[2], 10) };

  // "at 5", "5 o'clock", "around 11" — no am/pm, so guess the plausible one.
  m = text.match(/\b(?:at|around|by|@)\s*(\d{1,2})\b(?!\s*(?:st|nd|rd|th|\/|-))/) ?? text.match(/\b(\d{1,2})\s*o'?\s*clock\b/);
  if (m) {
    const h = parseInt(m[1], 10);
    if (h >= 13 && h <= 23) return { h, mi: 0 };
    if (h >= 1 && h <= 7) return { h: h + 12, mi: 0, assumed: true }; // "at 5" → 5 PM
    if (h >= 8 && h <= 11) return { h, mi: 0, assumed: true }; // "at 11" → 11 AM
    if (h === 12) return { h: 12, mi: 0 };
  }
  return null;
}

/** Morning / evening etc. when the caller gave no exact clock time. */
function dayPartHour(text: string): number | null {
  if (/\bearly morning\b/.test(text)) return 8;
  if (/\bmorning\b|\bsubah\b/.test(text)) return 10;
  if (/\bafternoon\b|\bdopahar\b/.test(text)) return 15;
  if (/\bevening\b|\bshaam\b/.test(text)) return 18;
  if (/\bnight\b|\btonight\b|\braat\b/.test(text)) return 20;
  return null;
}

/** Day named in the text, as IST y/m/d. */
function parseDay(text: string, now: Date): { y: number; mo: number; d: number } | null {
  const p = istParts(now);
  const addDays = (n: number) => {
    const t = new Date(Date.UTC(p.y, p.mo, p.d + n));
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() };
  };

  if (/\bday after tomorrow\b|\bparso\b/.test(text)) return addDays(2);
  if (/\btomorrow\b|\btmrw\b|\btomorow\b|\bkal\b/.test(text)) return addDays(1);
  if (/\btoday\b|\btonight\b|\baaj\b/.test(text)) return addDays(0);

  // "next monday", "this friday", "on saturday"
  for (let i = 0; i < 7; i++) {
    const re = new RegExp(`\\b(next|this|coming)?\\s*${WEEKDAYS[i]}\\b`);
    const m = text.match(re);
    if (m) {
      let diff = (i - p.wd + 7) % 7;
      if (m[1] === "next" && diff === 0) diff = 7; // "next Monday" said on a Monday = a week out
      return addDays(diff);
    }
  }

  // "18 october", "18th of october", "october 18", "oct 18th"
  const monthNames = MONTHS.map((x) => x.slice(0, 3)).join("|");
  let m = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthNames})[a-z]*\\.?(?:\\s*,?\\s*(\\d{4}))?`));
  let day: number | null = null, mon: number | null = null, year: number | null = null;
  if (m) { day = +m[1]; mon = MONTHS.findIndex((x) => x.startsWith(m![2])); year = m[3] ? +m[3] : null; }
  else {
    m = text.match(new RegExp(`\\b(${monthNames})[a-z]*\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`));
    if (m) { mon = MONTHS.findIndex((x) => x.startsWith(m![1])); day = +m[2]; year = m[3] ? +m[3] : null; }
  }
  // "18/10", "18-10-2026" (day first — Indian convention)
  if (day == null) {
    m = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
    if (m) { day = +m[1]; mon = +m[2] - 1; year = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null; }
  }
  if (day != null && mon != null && mon >= 0 && mon < 12 && day >= 1 && day <= 31) {
    let y = year ?? p.y;
    // No year given and the date already passed this year → next year.
    if (year == null) {
      const candidate = Date.UTC(y, mon, day);
      if (candidate < Date.UTC(p.y, p.mo, p.d)) y += 1;
    }
    return { y, mo: mon, d: day };
  }
  return null;
}

export function parseWhen(input: string, opts: ParseWhenOptions = {}): { ok: true; value: ParsedWhen } | { ok: false; error: WhenError } {
  const now = opts.now ?? new Date();
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "empty" };

  // 1) Machine-readable ISO timestamp (with offset, or bare = IST).
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) {
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    const bare = raw.replace(" ", "T");
    const t = Date.parse(hasZone ? bare : `${bare}${/:\d{2}:\d{2}/.test(bare) ? "" : ":00"}+05:30`);
    if (Number.isNaN(t)) return { ok: false, error: "unparseable" };
    const at = new Date(t);
    if (at.getTime() < now.getTime() - 60000) return { ok: false, error: "in_past" };
    return { ok: true, value: { at, spoken: formatIst(at), timeAssumed: false } };
  }

  const text = raw.toLowerCase().replace(/\s+/g, " ");

  // 2) Relative: "after 40 minutes", "in an hour".
  const rel = parseRelative(text, now);
  if (rel) {
    // Round up to the next whole minute so "30 minutes" never lands a few seconds early.
    const at = new Date(Math.ceil(rel.getTime() / 60000) * 60000);
    return { ok: true, value: { at, spoken: formatIst(at), timeAssumed: false } };
  }

  // 3) Day and/or clock time.
  const day = parseDay(text, now);
  const clock = parseClock(text);
  const part = clock ? null : dayPartHour(text);
  if (!day && !clock && part == null) return { ok: false, error: "unparseable" };

  let hour: number, minute: number, assumed = false;
  if (clock) { hour = clock.h; minute = clock.mi; assumed = !!clock.assumed; }
  else if (part != null) { hour = part; minute = 0; assumed = true; }
  else if (opts.defaultHour != null) { hour = opts.defaultHour; minute = 0; assumed = true; }
  else return { ok: false, error: "time_missing" };

  const p = istParts(now);
  let at: Date;
  if (day) {
    at = fromIst(day.y, day.mo, day.d, hour, minute);
  } else {
    // Time only: the next time that clock reading occurs.
    at = fromIst(p.y, p.mo, p.d, hour, minute);
    if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 86400000);
  }
  if (at.getTime() < now.getTime() - 60000) return { ok: false, error: "in_past" };
  return { ok: true, value: { at, spoken: formatIst(at), timeAssumed: assumed } };
}

/**
 * Parse an Indian-style money amount: "72 lakh", "1.2 crore", "65 L", "5000000",
 * "₹80,00,000", "50k". Returns rupees, or null when it isn't an amount.
 */
export function parseMoney(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (typeof input !== "string") return null;
  const t = input.toLowerCase().replace(/[₹,]|rs\.?|inr/g, "").trim();
  const m = t.match(/(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lac|l|thousand|k|million|m)?\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2] ?? "";
  const mult = /^cr/.test(u) ? 1e7 : /^(lakh|lac|l$)/.test(u) ? 1e5 : /^(thousand|k)$/.test(u) ? 1e3 : /^(million|m)$/.test(u) ? 1e6 : 1;
  return Math.round(n * mult);
}
