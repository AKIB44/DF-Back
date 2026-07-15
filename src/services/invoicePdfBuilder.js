'use strict';

// Patient-facing INVOICE for a clinical session — a clean bill of the services
// performed and their charges. Distinct from sessionSummaryPdfBuilder (which is a
// clinical treatment summary); this document is meant to be handed/sent to the
// patient. Visual language mirrors rxPdfBuilder / sessionSummaryPdfBuilder so all
// of a patient's documents look like one consistent set.

const PDFDocument = require('pdfkit');

// ─── Colour palette (shared) ──────────────────────────────────────────────────
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
const PAGE_BREAK_Y = PAGE_H - 150;

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
  return Array.isArray(arr) && arr.length ? arr.join(', ') : '';
}

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

  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.NAVY)
     .text('INVOICE', MARGIN, afterHeader + 8, { width: CONTENT_W, align: 'center' });

  return doc.y + 10;
}

function renderPatientStrip(doc, s, y) {
  const RCOL = PAGE_W - MARGIN - 170;

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.GRAY).text('BILL TO', MARGIN, y);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.NAVY)
     .text(s.patient_name || '-', MARGIN, doc.y + 2);
  const demo = [
    s.patient_phone,
    [s.patient_age != null ? `${s.patient_age} yrs` : null, s.patient_gender].filter(Boolean).join(' · '),
  ].filter(Boolean).join('   ');
  doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY).text(demo || '', MARGIN, doc.y + 1);

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.GRAY).text('INVOICE NO', RCOL, y, { width: 170, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.NAVY)
     .text(s.invoice_no || '-', RCOL, doc.y + 2, { width: 170, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY)
     .text(`${fmtDate(s.issued_at)}  ·  ${fmtTime(s.issued_at)}`, RCOL, doc.y + 1, { width: 170, align: 'right' });

  const docName = [s.doctor_first_name, s.doctor_last_name].filter(Boolean).join(' ');
  if (docName) {
    doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
       .text(`Dr. ${docName}`, RCOL, doc.y + 2, { width: 170, align: 'right' });
  }

  const lineY = Math.max(doc.y, y + 44) + 8;
  hline(doc, lineY);
  return lineY + 10;
}

function renderItemsTable(doc, s, y) {
  const items = s.items || [];

  // Column layout
  const X_DESC = MARGIN;
  const W_DESC = 230;
  const X_QTY  = MARGIN + 245;
  const X_GROSS = MARGIN + 300;
  const W_GROSS = 70;
  const X_DISC = MARGIN + 375;
  const W_DISC = 55;
  const X_AMT  = PAGE_W - MARGIN;          // right edge (right-aligned)
  const W_AMT  = 80;

  // Header row
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.GRAY);
  doc.text('SERVICE', X_DESC, y, { width: W_DESC });
  doc.text('QTY', X_QTY, y, { width: 40 });
  doc.text('GROSS', X_GROSS, y, { width: W_GROSS, align: 'right' });
  doc.text('DISCOUNT', X_DISC, y, { width: W_DISC, align: 'right' });
  doc.text('AMOUNT', X_AMT - W_AMT, y, { width: W_AMT, align: 'right' });
  y = doc.y + 4;
  hline(doc, y);
  y += 6;

  if (!items.length) {
    doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text('No billable services on this visit.', X_DESC, y);
    return doc.y + 8;
  }

  items.forEach((it) => {
    if (y > PAGE_BREAK_Y) { doc.addPage(); y = MARGIN + 10; }

    const rowTop = y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.NAVY)
       .text(it.service_name || 'Service', X_DESC, rowTop, { width: W_DESC });
    let descBottom = doc.y;

    const tn = teeth(it.tooth_numbers);
    if (tn) {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.GRAY)
         .text(`Teeth: ${tn}`, X_DESC, descBottom + 1, { width: W_DESC });
      descBottom = doc.y;
    }

    doc.font('Helvetica').fontSize(9).fillColor(C.GRAY)
       .text(String(it.quantity ?? 1), X_QTY, rowTop, { width: 40 });
    doc.font('Helvetica').fontSize(9).fillColor(C.GRAY)
       .text(inr(it.gross), X_GROSS, rowTop, { width: W_GROSS, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(it.discount > 0 ? C.TEAL : C.MUTED)
       .text(it.discount > 0 ? `- ${inr(it.discount)}` : '—', X_DISC, rowTop, { width: W_DISC, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.NAVY)
       .text(inr(it.final_charge), X_AMT - W_AMT, rowTop, { width: W_AMT, align: 'right' });

    y = Math.max(descBottom, rowTop + 12) + 6;
  });

  hline(doc, y);
  y += 10;

  // Totals block (right-aligned)
  const LBL_X = X_GROSS - 40;
  const LBL_W = 150;
  const totalRow = (label, value, opts = {}) => {
    const bold = opts.bold;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9)
       .fillColor(bold ? C.NAVY : C.GRAY)
       .text(label, LBL_X, y, { width: LBL_W, align: 'right' });
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
       .fillColor(bold ? C.TEAL : C.NAVY)
       .text(value, X_AMT - W_AMT, y, { width: W_AMT, align: 'right' });
    y = doc.y + 5;
  };

  totalRow('Subtotal', inr(s.subtotal));
  if (s.discount_total > 0) totalRow('Discount', `- ${inr(s.discount_total)}`);
  y += 2;
  hline(doc, y, C.LIGHT, 0.5);
  y += 8;
  totalRow('TOTAL PAYABLE', inr(s.total), { bold: true });

  return y + 8;
}

function renderNote(doc, s, y) {
  if (y > PAGE_H - 150) { doc.addPage(); y = MARGIN + 10; }
  y += 6;
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(C.MUTED)
     .text(
       s.sealed_at
         ? 'Amounts reflect the finalised charges for this visit.'
         : 'This visit is still in progress — amounts are provisional and may change until the session is finalised.',
       MARGIN, y, { width: CONTENT_W });
  return doc.y + 6;
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
     .text('This is a computer-generated invoice.', MARGIN, fy + 22, { width: CONTENT_W, align: 'center' });
}

// ─── Main build function ──────────────────────────────────────────────────────

async function build(invoice, { logoBuffer } = {}) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: MARGIN, autoFirstPage: true });
    // The note + footer are drawn at absolute positions inside the bottom margin.
    // PDFKit auto-adds a blank page whenever the text cursor passes
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
      let y = renderHeader(doc, invoice, logoBuffer);
      y = renderPatientStrip(doc, invoice, y);
      y = renderItemsTable(doc, invoice, y);
      renderNote(doc, invoice, y);
      renderFooter(doc, invoice);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { build };
