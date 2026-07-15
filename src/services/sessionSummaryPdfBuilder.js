'use strict';

// Treatment Summary + Invoice PDF for a sealed clinical session.
// Visual language mirrors rxPdfBuilder (same palette / letterhead) so a patient's
// prescription and treatment-summary documents look like one consistent set.

const PDFDocument = require('pdfkit');

// ─── Colour palette (shared with rxPdfBuilder) ────────────────────────────────
const C = {
  TEAL:      '#0D7A5F',
  TEAL_DARK: '#095C47',
  NAVY:      '#0F172A',
  GRAY:      '#64748B',
  LIGHT:     '#E2E8F0',
  WHITE:     '#FFFFFF',
  MUTED:     '#94A3B8',
};

// ─── Layout constants (A4 = 595 × 842 pt, margin 45) ─────────────────────────
const PAGE_W    = 595;
const PAGE_H    = 842;
const MARGIN    = 45;
const CONTENT_W = PAGE_W - MARGIN * 2;   // 505 pt
const PAGE_BREAK_Y = PAGE_H - 130;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hline(doc, y, color = C.LIGHT, width = 0.5) {
  doc.save()
     .moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y)
     .strokeColor(color).lineWidth(width).stroke()
     .restore();
}

function fmtDate(dt) {
  if (!dt) return '-';
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(dt));
}

function fmtTime(dt) {
  if (!dt) return '-';
  return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
    .format(new Date(dt));
}

function inr(n) {
  return `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function teeth(arr) {
  return Array.isArray(arr) && arr.length ? arr.join(', ') : '—';
}

const STATUS_LABEL = {
  COMPLETED: 'Completed',
  PARTIAL:   'Partial',
  ABANDONED: 'Abandoned',
  IN_PROGRESS: 'In progress',
};

// ─── Section renderers ────────────────────────────────────────────────────────

function renderHeader(doc, s, logoBuffer) {
  const TOP   = 45;
  const BOX_H = 80;
  const MID_X = MARGIN + BOX_H + 8;
  const MID_W = CONTENT_W - BOX_H - 16;

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, MARGIN, TOP, { fit: [BOX_H, BOX_H], align: 'center', valign: 'center' });
    } catch (_) {}
  }

  doc.font('Helvetica-Bold').fontSize(17).fillColor(C.TEAL)
     .text(s.clinic_name || 'DentaFlow Clinic', MID_X, TOP + 2, { width: MID_W, align: 'center' });

  const addrLine = [s.clinic_address, s.clinic_city].filter(Boolean).join(', ');
  const contLine = [s.clinic_phone, s.clinic_email].filter(Boolean).join('  |  ');

  doc.font('Helvetica').fontSize(8).fillColor(C.GRAY)
     .text(addrLine, MID_X, doc.y + 3, { width: MID_W, align: 'center' })
     .text(contLine, MID_X, doc.y + 2, { width: MID_W, align: 'center' });

  const afterHeader = TOP + BOX_H + 6;
  hline(doc, afterHeader, C.TEAL, 1);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.NAVY)
     .text('TREATMENT SUMMARY & INVOICE', MARGIN, afterHeader + 8, { width: CONTENT_W, align: 'center' });

  return doc.y + 10;
}

function renderPatientStrip(doc, s, y) {
  const RCOL = PAGE_W - MARGIN - 170;

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.GRAY).text('PATIENT', MARGIN, y);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.NAVY)
     .text(s.patient_name || '-', MARGIN, doc.y + 2);
  const demo = [
    s.patient_phone,
    [s.patient_age != null ? `${s.patient_age} yrs` : null, s.patient_gender].filter(Boolean).join(' · '),
  ].filter(Boolean).join('   ');
  doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY).text(demo || '', MARGIN, doc.y + 1);

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.GRAY).text('INVOICE', RCOL, y, { width: 170, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.NAVY)
     .text(s.invoice_no || '-', RCOL, doc.y + 2, { width: 170, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY)
     .text(`${fmtDate(s.sealed_at)}  ·  ${fmtTime(s.sealed_at)}`, RCOL, doc.y + 1, { width: 170, align: 'right' });

  const docName = [s.doctor_first_name, s.doctor_last_name].filter(Boolean).join(' ');
  if (docName) {
    doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
       .text(`Dr. ${docName}`, RCOL, doc.y + 2, { width: 170, align: 'right' });
  }

  const lineY = Math.max(doc.y, y + 44) + 8;
  hline(doc, lineY);
  return lineY + 10;
}

function renderDiagnoses(doc, s, y) {
  const dx = s.diagnoses || [];
  if (!dx.length) return y;

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.GRAY).text('DIAGNOSES', MARGIN, y);
  y = doc.y + 4;

  dx.forEach((d) => {
    if (y > PAGE_BREAK_Y) { doc.addPage(); y = MARGIN + 10; }
    const code = d.icd10_code ? `[${d.icd10_code}] ` : '';
    const tn   = Array.isArray(d.tooth_numbers) && d.tooth_numbers.length ? `  ·  Teeth: ${d.tooth_numbers.join(', ')}` : '';
    doc.font('Helvetica').fontSize(9.5).fillColor(C.NAVY)
       .text(`•  ${code}${d.diagnosis_text || ''}${tn}`, MARGIN + 4, y, { width: CONTENT_W - 4 });
    y = doc.y + 3;
  });

  hline(doc, y + 2);
  return y + 10;
}

function renderInvoiceTable(doc, s, y) {
  const services = s.services || [];

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.GRAY).text('SERVICES PERFORMED', MARGIN, y);
  y = doc.y + 6;

  // Column layout
  const X_SVC   = MARGIN;
  const X_TEETH = MARGIN + 250;
  const X_STAT  = MARGIN + 330;
  const X_AMT   = PAGE_W - MARGIN;          // right edge (right-aligned)
  const W_AMT   = 90;

  // Header row
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.GRAY);
  doc.text('SERVICE', X_SVC, y);
  doc.text('TEETH', X_TEETH, y);
  doc.text('STATUS', X_STAT, y);
  doc.text('CHARGE', X_AMT - W_AMT, y, { width: W_AMT, align: 'right' });
  y = doc.y + 4;
  hline(doc, y);
  y += 6;

  if (!services.length) {
    doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text('No services recorded.', X_SVC, y);
    return doc.y + 8;
  }

  services.forEach((sv) => {
    if (y > PAGE_BREAK_Y) { doc.addPage(); y = MARGIN + 10; }

    const rowTop = y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.NAVY)
       .text(sv.service_name || 'Service', X_SVC, y, { width: 200 });
    const svcBottom = doc.y;

    doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY)
       .text(teeth(sv.tooth_numbers), X_TEETH, rowTop, { width: 70 });
    doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY)
       .text(STATUS_LABEL[sv.status] || sv.status || '—', X_STAT, rowTop, { width: 70 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.NAVY)
       .text(inr(sv.final_charge), X_AMT - W_AMT, rowTop, { width: W_AMT, align: 'right' });

    y = Math.max(svcBottom, rowTop + 12) + 6;
  });

  hline(doc, y);
  y += 8;

  // Total row
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.NAVY)
     .text('TOTAL', X_STAT, y, { width: 120 });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.TEAL)
     .text(inr(s.total), X_AMT - W_AMT, y, { width: W_AMT, align: 'right' });
  y = doc.y + 6;

  if (s.variance_reason) {
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.MUTED)
       .text(`Variance note: ${s.variance_reason}`, MARGIN, y, { width: CONTENT_W });
    y = doc.y + 4;
  }

  hline(doc, y + 2);
  return y + 10;
}

function renderPrescriptions(doc, s, y) {
  const rxs = s.prescriptions || [];
  if (!rxs.length) return y;

  if (y > PAGE_BREAK_Y - 40) { doc.addPage(); y = MARGIN + 10; }

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.GRAY).text('PRESCRIPTIONS', MARGIN, y);
  y = doc.y + 6;

  rxs.forEach((r, idx) => {
    if (y > PAGE_BREAK_Y) { doc.addPage(); y = MARGIN + 10; }

    const name = [r.medicine_name || r.generic_name, r.medicine_strength || r.strength].filter(Boolean).join(' ');
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.NAVY)
       .text(`${idx + 1}.  ${name || 'Medicine'}`, MARGIN, y, { width: CONTENT_W });
    y = doc.y + 2;

    const meta = [r.dosage, r.frequency, r.duration, r.quantity ? `Qty: ${r.quantity}` : null, r.instructions]
      .filter(Boolean).join('  ·  ');
    if (meta) {
      doc.font('Helvetica').fontSize(8).fillColor(C.GRAY).text(meta, MARGIN + 12, y, { width: CONTENT_W - 12 });
      y = doc.y + 2;
    }
    y += 4;
  });

  hline(doc, y + 2);
  return y + 10;
}

function renderSignatures(doc, s, y) {
  const SIG_Y = PAGE_H - 120;
  if (y > SIG_Y) { doc.addPage(); y = MARGIN + 10; } else { y = SIG_Y; }

  hline(doc, y, C.LIGHT, 0.5);
  y += 16;

  const colW = 200;
  const leftX  = MARGIN;
  const rightX = PAGE_W - MARGIN - colW;
  const lineY  = y + 30;

  doc.moveTo(leftX, lineY).lineTo(leftX + colW, lineY).strokeColor(C.GRAY).lineWidth(0.5).stroke();
  doc.moveTo(rightX, lineY).lineTo(rightX + colW, lineY).strokeColor(C.GRAY).lineWidth(0.5).stroke();

  doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY)
     .text('Patient Signature', leftX, lineY + 4, { width: colW, align: 'center' });

  const docName = [s.doctor_first_name, s.doctor_last_name].filter(Boolean).join(' ');
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.NAVY)
     .text(docName ? `Dr. ${docName}` : 'Doctor Signature', rightX, lineY + 4, { width: colW, align: 'center' });
  if (s.doctor_designation) {
    doc.font('Helvetica').fontSize(8).fillColor(C.GRAY)
       .text(s.doctor_designation, rightX, doc.y + 1, { width: colW, align: 'center' });
  }
}

function renderFooter(doc, s) {
  const FOOTER_H = 38;
  const fy       = PAGE_H - FOOTER_H;

  doc.save().rect(0, fy, PAGE_W, FOOTER_H).fill(C.TEAL_DARK).restore();
  doc.save().moveTo(0, fy).lineTo(PAGE_W, fy).strokeColor(C.TEAL).lineWidth(1.5).stroke().restore();

  const parts = [
    s.clinic_name,
    [s.clinic_address, s.clinic_city].filter(Boolean).join(', '),
    s.clinic_phone,
    s.clinic_email,
  ].filter(Boolean);

  doc.font('Helvetica').fontSize(7.5).fillColor(C.WHITE)
     .text(parts.join('  ·  '), MARGIN, fy + 8, { width: CONTENT_W, align: 'center' });

  doc.font('Helvetica').fontSize(6.5).fillColor('#A7F3D0')
     .text('This is a computer-generated treatment summary & invoice.', MARGIN, fy + 22, { width: CONTENT_W, align: 'center' });
}

// ─── Main build function ──────────────────────────────────────────────────────

async function build(summary, { logoBuffer } = {}) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: MARGIN, autoFirstPage: true });
    // The signatures + footer are drawn at absolute positions inside the bottom
    // margin. PDFKit auto-adds a blank page whenever the text cursor passes
    // `pageHeight - margins.bottom`, so those writes would spawn extra pages.
    // Zeroing the bottom margin disables that auto-pagination — real overflow is
    // still handled explicitly via the PAGE_BREAK_Y checks.
    doc.page.margins.bottom = 0;
    doc.on('pageAdded', () => { doc.page.margins.bottom = 0; });
    const chunks = [];
    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      let y = renderHeader(doc, summary, logoBuffer);
      y = renderPatientStrip(doc, summary, y);
      y = renderDiagnoses(doc, summary, y);
      y = renderInvoiceTable(doc, summary, y);
      y = renderPrescriptions(doc, summary, y);
      renderSignatures(doc, summary, y);
      renderFooter(doc, summary);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { build };
