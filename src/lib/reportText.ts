import type { MedicineCheckResult, ReportInput, ReportType } from './medicheck.js';

export const SAFETY_DISCLAIMER =
  'Information only. Do not change or stop a prescribed medicine without asking your doctor or pharmacist.';

const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  sold_above_mrp: 'Medicine sold above printed MRP',
  price_above_ceiling: 'Printed or charged price exceeds NPPA ceiling threshold',
  out_of_stock: 'Essential medicine unavailable / out of stock',
  suspect_batch_or_pack: 'Suspect batch number or packaging quality concern',
  bill_refused: 'Pharmacy declined to provide a formal cash memo / GST invoice',
};

const CEILING_STATUS_LABELS: Record<MedicineCheckResult['price']['ceiling_status'], string> = {
  within: 'Within ceiling price',
  above: 'Above ceiling price',
  no_ceiling: 'No ceiling price available',
};

/**
 * Formats a neutral, factual plain-text summary suitable for copying or submitting
 * to NPPA (Pharma Jan Samadhan), CDSCO, or a State Drug Control Authority.
 *
 * Wording policy: Flags observations neutrally based on reference datasets; never accuses.
 */
export function buildReportText(
  check: MedicineCheckResult | null | undefined,
  reportInput: ReportInput
): string {
  const lines: string[] = [];

  lines.push('============================================================');
  lines.push('MEDICHECK PATIENT OBSERVATION REPORT');
  lines.push('============================================================');
  lines.push(`Generated On : ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Issue Category: ${REPORT_TYPE_LABELS[reportInput.report_type] ?? reportInput.report_type} (${reportInput.report_type})`);
  lines.push('');

  lines.push('--- PHARMACY DETAILS ---');
  lines.push(`Pharmacy Name      : ${reportInput.pharmacy_name.trim()}`);
  lines.push(
    `Pharmacy Licence No: ${
      reportInput.pharmacy_licence_no?.trim() ? reportInput.pharmacy_licence_no.trim() : 'Not provided'
    }`
  );
  lines.push('');

  lines.push('--- MEDICINE & BATCH DETAILS ---');
  if (check) {
    const p = check.product;
    lines.push(`Brand Name         : ${p.brand_name}`);
    lines.push(`Composition (Salt) : ${p.salt_normalized} (${p.strength}, ${p.dosage_form})`);
    lines.push(`Manufacturer       : ${p.manufacturer}`);
    lines.push(`Pack Size          : ${p.pack_size} ${p.pack_unit}`);
    lines.push(
      `Batch Number       : ${
        reportInput.batch_number?.trim() || check.batch.batch_queried || 'Not specified'
      }`
    );
    lines.push('');

    lines.push('--- PRICE & CEILING REFERENCE ---');
    lines.push(`Printed MRP        : Rs ${Number(check.price.printed_mrp).toFixed(2)} per pack`);
    lines.push(
      `Unit Price         : Rs ${Number(check.price.price_per_unit).toFixed(2)} per ${p.pack_unit}`
    );
    lines.push(
      `Ceiling Comparison : ${CEILING_STATUS_LABELS[check.price.ceiling_status]}`
    );
    if (check.price.ceiling_row) {
      lines.push(
        `NPPA Base Ceiling  : Rs ${Number(check.price.ceiling_row.ceiling_price).toFixed(2)} per ${check.price.ceiling_row.pack_unit} (Ref: ${check.price.ceiling_row.notification_ref ?? 'NPPA'})`
      );
      if (check.price.effective_ceiling_per_unit_with_gst !== null) {
        lines.push(
          `Ceiling + ${check.price.gst_allowance_percent}% GST : Rs ${Number(
            check.price.effective_ceiling_per_unit_with_gst
          ).toFixed(2)} per ${check.price.ceiling_row.pack_unit}`
        );
      }
    }
    lines.push(`GST Note           : ${check.price.gst_note}`);
    lines.push('');

    lines.push('--- CDSCO BATCH ALERT CHECK ---');
    if (check.batch.checked) {
      if (check.batch.flagged && check.batch.alert) {
        lines.push('Batch Status       : Batch flagged by CDSCO');
        lines.push(`Alert Category     : ${check.batch.alert.category}`);
        lines.push(
          `Reported Reason    : ${check.batch.alert.failure_reason ?? 'Listed in CDSCO alert notice'}`
        );
        lines.push(
          `Alert Source Date  : ${check.batch.alert.source_date ?? check.batch.alert.alert_month}`
        );
      } else {
        lines.push('Batch Status       : Batch not found in latest CDSCO lists');
      }
    } else {
      lines.push('Batch Status       : No batch number checked');
    }
    lines.push('');
  } else {
    lines.push(`Product ID         : ${reportInput.brand_product_id ?? 'Not linked'}`);
    lines.push(`Batch Number       : ${reportInput.batch_number?.trim() || 'Not specified'}`);
    lines.push('');
  }

  lines.push('--- PATIENT DESCRIPTION ---');
  lines.push(reportInput.description.trim());
  lines.push('');

  lines.push('--- DATASET SOURCE DATES (DATA AS OF) ---');
  if (check && Object.keys(check.data_dates).length > 0) {
    for (const [dataset, sourceDate] of Object.entries(check.data_dates)) {
      lines.push(`- ${dataset}: data as of ${sourceDate}`);
    }
  } else {
    lines.push('- Reference dataset dates unavailable');
  }
  lines.push('');

  lines.push('--- IMPORTANT NOTE & DISCLAIMER ---');
  lines.push(
    'This report is generated from patient-supplied details and publicly available regulatory reference datasets for verification by the appropriate authority.'
  );
  lines.push(check?.safety_note ?? SAFETY_DISCLAIMER);
  lines.push('============================================================');

  return lines.join('\n');
}
