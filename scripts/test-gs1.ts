import assert from 'node:assert/strict';
import { parseScan, gtinCandidates } from '../src/lib/gs1.js';

const NOW = new Date('2026-10-30T12:00:00');
const GS = '\x1D';
let passed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test('parentheses format', () => {
  const r = parseScan('(01)08901234567890(17)270531(10)ABC123', NOW);
  assert.equal(r.kind, 'gs1');
  assert.equal(r.gtin, '08901234567890');
  assert.equal(r.batch, 'ABC123');
  assert.equal(r.serial, null);
  assert.deepEqual(r.expiry, { raw: '270531', iso: '2027-05-31', expired: false });
});

test('parentheses format with serial and production date', () => {
  const r = parseScan('(01)08901234567890(11)250115(17)270531(10)B1(21)SN42', NOW);
  assert.equal(r.serial, 'SN42');
  assert.equal(r.manufactured, '2025-01-15');
  assert.equal(r.batch, 'B1');
});

test('raw format with GS separator after batch', () => {
  const r = parseScan(`010890123456789017270531` + `10ABC123${GS}21SER99`, NOW);
  assert.equal(r.kind, 'gs1');
  assert.equal(r.gtin, '08901234567890');
  assert.equal(r.batch, 'ABC123');
  assert.equal(r.serial, 'SER99');
  assert.equal(r.expiry?.iso, '2027-05-31');
});

test('raw format with <GS> and <FNC1> separator variants', () => {
  const r = parseScan('<FNC1>010990000000001110TST1234<GS>1727053121SN001', NOW);
  assert.equal(r.kind, 'gs1');
  assert.equal(r.gtin, '09900000000011');
  assert.equal(r.batch, 'TST1234');
  assert.equal(r.expiry?.iso, '2027-05-31');
  assert.equal(r.serial, 'SN001');
});

test('raw format, batch last (no separator)', () => {
  const r = parseScan('01089012345678901727053110ABC123', NOW);
  assert.equal(r.kind, 'gs1');
  assert.equal(r.batch, 'ABC123');
});

test('raw format, variable field first then GS then fixed field', () => {
  const r = parseScan(`0108901234567890` + `10LOT7${GS}17270531`, NOW);
  assert.equal(r.batch, 'LOT7');
  assert.equal(r.expiry?.iso, '2027-05-31');
});

test('symbology prefix ]d2', () => {
  const r = parseScan(`]d2010890123456789017270531` + `10ABC123`, NOW);
  assert.equal(r.kind, 'gs1');
  assert.equal(r.gtin, '08901234567890');
  assert.equal(r.batch, 'ABC123');
});

test('symbology prefix ]C1 and ]Q3 (digital link)', () => {
  const a = parseScan(']C1' + '0108901234567890' + '10X9', NOW);
  assert.equal(a.kind, 'gs1');
  assert.equal(a.batch, 'X9');
  const b = parseScan(']Q3https://example.com/01/08901234567890/10/ABC123', NOW);
  assert.equal(b.kind, 'digital_link');
  assert.equal(b.batch, 'ABC123');
});

test('digital link with query expiry and encoded batch', () => {
  const r = parseScan('https://example.com/01/08901234567890/10/DLM-2409%2FA/21/S%201?17=270531', NOW);
  assert.equal(r.kind, 'digital_link');
  assert.equal(r.gtin, '08901234567890');
  assert.equal(r.batch, 'DLM-2409/A');
  assert.equal(r.serial, 'S 1');
  assert.equal(r.expiry?.iso, '2027-05-31');
});

test('digital link without gtin returns nulls', () => {
  const r = parseScan('https://example.com/some/page', NOW);
  assert.equal(r.kind, 'unknown');
  assert.equal(r.gtin, null);
  assert.equal(r.batch, null);
  assert.equal(r.expiry, null);
});

test('plain EAN-13 returns null batch/expiry', () => {
  const r = parseScan('8901000000011', NOW);
  assert.equal(r.kind, 'plain_barcode');
  assert.equal(r.gtin, '8901000000011');
  assert.equal(r.batch, null);
  assert.equal(r.expiry, null);
});

test('plain EAN-8 and UPC-A', () => {
  assert.deepEqual(parseScan('96385074', NOW), {
    kind: 'plain_barcode',
    gtin: '96385074',
    batch: null,
    expiry: null,
    serial: null,
    manufactured: null,
    raw: '96385074',
  });
  assert.equal(parseScan('036000291452', NOW).gtin, '036000291452');
});

test('expiry day 00 = end of month (incl. leap year)', () => {
  assert.equal(parseScan('(01)08901234567890(17)270200', NOW).expiry?.iso, '2027-02-28');
  assert.equal(parseScan('(01)08901234567890(17)280200', NOW).expiry?.iso, '2028-02-29');
});

test('expired pack and invalid date', () => {
  assert.equal(parseScan('(01)08901234567890(17)200131', NOW).expiry?.expired, true);
  assert.equal(parseScan('(01)08901234567890(17)261030', NOW).expiry?.expired, false); // today
  assert.deepEqual(parseScan('(01)08901234567890(17)271301', NOW).expiry, {
    raw: '271301',
    iso: null,
    expired: null,
  });
});

test('batch with special characters (both formats)', () => {
  assert.equal(parseScan('(01)08901234567890(10)DLM-2409/A', NOW).batch, 'DLM-2409/A');
  assert.equal(parseScan(`0108901234567890` + `10DLM-2409/A${GS}17270531`, NOW).batch, 'DLM-2409/A');
});

test('garbage, empty and non-string input return nulls and never throw', () => {
  for (const g of ['hello world', '!!!###', '(01)123', '0199', '12345', '', '   ', '(((', '\x1D\x1D']) {
    const r = parseScan(g, NOW);
    assert.equal(r.kind, 'unknown', `input ${JSON.stringify(g)}`);
    assert.equal(r.gtin, null);
    assert.equal(r.batch, null);
    assert.equal(r.expiry, null);
    assert.equal(r.serial, null);
  }
  assert.equal(parseScan(undefined as unknown as string, NOW).gtin, null);
  assert.equal(parseScan(null as unknown as string, NOW).gtin, null);
});

test('raw is preserved unchanged', () => {
  const input = ']d201089012345678901727053110ABC123';
  assert.equal(parseScan(input, NOW).raw, input);
});

test('gtinCandidates', () => {
  assert.deepEqual(gtinCandidates('8901000000011'), ['8901000000011', '08901000000011']);
  assert.deepEqual(gtinCandidates('08901000000011'), ['08901000000011', '8901000000011']);
  assert.deepEqual(gtinCandidates('96385074'), ['96385074', '00000096385074']);
  assert.deepEqual(gtinCandidates('18901000000018'), ['18901000000018']);
  assert.deepEqual(gtinCandidates(''), []);
});

console.log(`\n${passed} GS1 unit test(s) passed${process.exitCode ? ', some FAILED' : ''}`);
