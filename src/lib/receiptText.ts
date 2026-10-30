import type { Receipt, ReceiptVerification } from './medicheck.js';

export const LOG_NOTE =
  'The fingerprint log is publicly checkable. A sealed record shows this report has not been changed since it was filed; it does not confirm that its contents were true.';

/** Plain-text Proof Receipt the user can copy, save or send along with a complaint. */
export function buildReceiptText(receipt: Receipt, verify: ReceiptVerification | null | undefined): string {
  const r = receipt.report;
  const L: string[] = [];

  L.push('============================================================');
  L.push('MEDICHECK PROOF RECEIPT');
  L.push('============================================================');
  L.push(`Report ID      : ${receipt.report_id}`);
  L.push(`Filed          : ${receipt.filed_at}`);
  L.push(`Record number  : ${receipt.seq}`);
  L.push('');
  L.push('--- WHAT WAS FILED ---');
  L.push(`Issue type     : ${r.report_type}`);
  L.push(`Pharmacy ref   : ${r.pharmacy_ref ?? 'Not available'} (anonymised; the name is not in the public log)`);
  if (r.brand_name) L.push(`Medicine       : ${r.brand_name}`);
  if (r.salt_normalized) L.push(`Composition    : ${r.salt_normalized}${r.strength ? ` (${r.strength}${r.dosage_form ? `, ${r.dosage_form}` : ''})` : ''}`);
  L.push(`Batch          : ${r.batch_number ?? 'Not provided'}`);
  L.push('');
  L.push('--- SEALED RECORD ---');
  for (const step of receipt.timeline) {
    L.push(`${step.sealed ? '[✔ sealed]' : '[ pending ]'} ${step.step} - ${step.at}`);
  }
  L.push(`Fingerprint    : ${receipt.entry_hash}`);
  L.push('');
  L.push('--- VERIFY ---');
  if (verify) {
    L.push(`${verify.valid ? '✔' : '✖'} ${verify.message}`);
  } else {
    L.push('Not verified yet. Use Verify in the app to check this record.');
  }
  L.push('');
  L.push('--- SILENCE CLOCK & GOVERNMENT PROGRESS ---');
  if (receipt.authority_response === null) {
    L.push(`Day ${receipt.days_since_filing} since filing, no official response recorded.`);
  } else {
    const ar = receipt.authority_response;
    L.push(`Day ${receipt.days_since_filing} since filing, official status: ${ar.status.toUpperCase()}`);
    L.push(`Responding Agency : ${ar.agency_name}${ar.officer_designation ? ` (${ar.officer_designation})` : ''}`);
    if (ar.action_taken) {
      L.push(`Action Taken      : ${ar.action_taken}`);
    }
    L.push(`Progress Note     : ${ar.progress_note}`);
    if (ar.proof_urls && ar.proof_urls.length > 0) {
      L.push(`Proof Attachments : ${ar.proof_urls.join(', ')}`);
    }
  }
  L.push('');
  L.push(LOG_NOTE);
  L.push('============================================================');
  return L.join('\n');
}
