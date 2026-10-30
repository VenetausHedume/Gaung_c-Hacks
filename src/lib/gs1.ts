/**
 * Pure, offline parser for medicine pack scans (GS1 element strings, DataMatrix/QR,
 * GS1 Digital Links, plain EAN/UPC barcodes). Never throws and never guesses.
 */

export interface ScanExpiry {
  /** The raw YYMMDD value from the scan. */
  raw: string;
  /** YYYY-MM-DD (day "00" = last day of month) or null if the date is invalid. */
  iso: string | null;
  /** true if iso is before today, null if iso is null. */
  expired: boolean | null;
}

export interface ParsedScan {
  kind: 'gs1' | 'digital_link' | 'plain_barcode' | 'unknown';
  gtin: string | null;
  batch: string | null;
  expiry: ScanExpiry | null;
  serial: string | null;
  /** AI 11 production date as YYYY-MM-DD (day "00" = last day of month) or null. */
  manufactured: string | null;
  raw: string;
}

const GS = '\x1D';

// Application Identifiers supported by the raw-format parser.
const FIXED_AI: Record<string, number> = {
  '00': 18,
  '01': 14,
  '02': 14,
  '11': 6,
  '12': 6,
  '13': 6,
  '15': 6,
  '16': 6,
  '17': 6,
  '20': 2,
};

const VARIABLE_AI: Record<string, number> = {
  '10': 20,
  '21': 20,
  '22': 20,
  '30': 8,
  '240': 30,
  '241': 30,
  '242': 6,
  '250': 30,
  '251': 30,
  '400': 30,
  '91': 90,
  '92': 90,
  '93': 90,
  '94': 90,
  '95': 90,
  '96': 90,
  '97': 90,
  '98': 90,
  '99': 90,
};

const pad2 = (n: number) => String(n).padStart(2, '0');

function localToday(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function unknownScan(raw: string): ParsedScan {
  return {
    kind: 'unknown',
    gtin: null,
    batch: null,
    expiry: null,
    serial: null,
    manufactured: null,
    raw,
  };
}

/** YYMMDD -> ISO. Century is assumed to be 20xx. Day 00 = last day of month. */
function gs1DateToIso(raw: string): string | null {
  if (!/^\d{6}$/.test(raw)) return null;
  const year = 2000 + Number(raw.slice(0, 2));
  const month = Number(raw.slice(2, 4));
  const dd = Number(raw.slice(4, 6));
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = dd === 0 ? daysInMonth : dd;
  if (day > daysInMonth) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function buildResult(
  raw: string,
  kind: 'gs1' | 'digital_link',
  ais: Map<string, string>,
  now: Date
): ParsedScan {
  const gtin = ais.get('01') ?? null;
  if (gtin !== null && !/^\d{14}$/.test(gtin)) {
    return unknownScan(raw);
  }
  if (ais.size === 0) {
    return unknownScan(raw);
  }

  const batch = ais.get('10') ?? null;
  const serial = ais.get('21') ?? null;

  let expiry: ScanExpiry | null = null;
  const exp = ais.get('17');
  if (exp !== undefined) {
    const iso = gs1DateToIso(exp);
    expiry = { raw: exp, iso, expired: iso === null ? null : iso < localToday(now) };
  }

  let manufactured: string | null = null;
  const mfd = ais.get('11');
  if (mfd !== undefined) {
    manufactured = gs1DateToIso(mfd) ?? mfd;
  }

  if (!gtin && !batch && !expiry && !serial && !manufactured) {
    return unknownScan(raw);
  }

  return {
    kind,
    gtin,
    batch,
    expiry,
    serial,
    manufactured,
    raw,
  };
}

function parseParenthesised(s: string): Map<string, string> | null {
  const ais = new Map<string, string>();
  const re = /\((\d{2,4})\)([^(]*)/g;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== consumed) return null;
    consumed = re.lastIndex;
    const value = m[2].split(GS).join('').trim();
    if (value === '') return null;
    if (!ais.has(m[1])) ais.set(m[1], value);
  }
  return consumed === s.length && ais.size > 0 ? ais : null;
}

function parseRawElementString(s: string): Map<string, string> | null {
  const ais = new Map<string, string>();
  let pos = 0;
  while (pos < s.length) {
    if (s[pos] === GS) {
      pos++;
      continue;
    }
    let ai: string | null = null;
    for (const len of [2, 3, 4]) {
      const cand = s.slice(pos, pos + len);
      if (cand in FIXED_AI || cand in VARIABLE_AI) {
        ai = cand;
        break;
      }
    }
    if (ai === null) return null;
    pos += ai.length;

    let value: string;
    if (ai in FIXED_AI) {
      value = s.slice(pos, pos + FIXED_AI[ai]);
      if (value.length !== FIXED_AI[ai] || !/^\d+$/.test(value)) return null;
      pos += value.length;
    } else {
      const gsIdx = s.indexOf(GS, pos);
      const end = gsIdx === -1 ? s.length : gsIdx;
      value = s.slice(pos, end);
      if (value.length === 0 || value.length > VARIABLE_AI[ai]) return null;
      pos = end;
    }
    if (!ais.has(ai)) ais.set(ai, value);
  }
  return ais.size > 0 ? ais : null;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function parseDigitalLink(s: string): Map<string, string> | null {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const ais = new Map<string, string>();
  const keys = new Set(['01', '10', '21', '17', '11']);

  const segs = url.pathname.split('/').filter((x) => x !== '');
  for (let i = 0; i < segs.length - 1; i++) {
    if (keys.has(segs[i]) && !ais.has(segs[i])) {
      ais.set(segs[i], safeDecode(segs[i + 1]));
      i++;
    }
  }
  url.searchParams.forEach((value, key) => {
    if (keys.has(key) && !ais.has(key)) ais.set(key, value);
  });
  return ais.has('01') ? ais : null;
}

/**
 * Parse whatever a barcode/QR scanner returned. Never throws; returns nulls when unparseable.
 * Handles FNC1 / group-separator variants (\x1D, <GS>, <FNC1>, {GS}, ]d2, ]Q3, ]C1) and parenthesised forms.
 */
export function parseScan(raw: string, now: Date = new Date()): ParsedScan {
  const original = typeof raw === 'string' ? raw : String(raw ?? '');
  try {
    // Convert common scanner text representations of FNC1 / GS into ASCII 29 (\x1D),
    // strip AIM symbology identifiers (e.g. ]d2, ]Q3, ]C1, ]E0), and strip leading GS.
    const s = original
      .replace(/^\s+/, '')
      .replace(/<(?:GS|FNC1)>|\{(?:GS|FNC1)\}|\\x1[dD]|\u241D/g, GS)
      .replace(/^\][A-Za-z][0-9A-Za-z]/, '')
      .replace(/^[\x1D\s]+/, '')
      .trim();

    if (s === '') return unknownScan(original);

    if (/^https?:\/\//i.test(s)) {
      const ais = parseDigitalLink(s);
      return ais ? buildResult(original, 'digital_link', ais, now) : unknownScan(original);
    }

    if (/^\d{8}$|^\d{12,14}$/.test(s)) {
      return {
        kind: 'plain_barcode',
        gtin: s,
        batch: null,
        expiry: null,
        serial: null,
        manufactured: null,
        raw: original,
      };
    }

    const ais = s.startsWith('(') ? parseParenthesised(s) : parseRawElementString(s);
    return ais ? buildResult(original, 'gs1', ais, now) : unknownScan(original);
  } catch {
    return unknownScan(original);
  }
}

/**
 * Barcode lookup variants to try, in order: as given, 14-digit zero-padded,
 * and the 13-digit form with a single leading zero removed (EAN-13 inside a GTIN-14).
 */
export function gtinCandidates(gtin: string): string[] {
  const g = (gtin ?? '').trim();
  if (g === '') return [];
  if (!/^\d+$/.test(g)) return [g];
  const out: string[] = [g];
  const padded = g.length < 14 ? g.padStart(14, '0') : g;
  if (!out.includes(padded)) out.push(padded);
  if (g.length >= 13 && padded.startsWith('0')) {
    const ean13 = padded.slice(1);
    if (!out.includes(ean13)) out.push(ean13);
  }
  return out;
}
