'use strict';

const PDFDocument = require('pdfkit');
const QRCode      = require('qrcode');

// ─── Colour palette ───────────────────────────────────────────────────────────
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
const PAGE_W  = 595;
const PAGE_H  = 842;
const MARGIN  = 45;
const CONTENT_W = PAGE_W - MARGIN * 2;   // 505 pt

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

function medTitle(item)  { return [item.medicine_name, item.medicine_strength].filter(Boolean).join(' '); }
function procTitle(item) { return item.procedure_name || item.procedure_code || 'Procedure'; }

function medDetail(item) {
  return [item.dosage, item.frequency, item.duration,
          item.quantity ? `Qty: ${item.quantity}` : null,
          item.instructions]
    .filter(Boolean).join('  ·  ');
}

function procDetail(item) {
  const status = item.procedure_status
    ? { planned: '○ Planned', done: '✓ Done', skipped: '— Skipped' }[item.procedure_status] || ''
    : '';
  return [status, item.instructions || item.default_notes].filter(Boolean).join('  ·  ');
}

async function buildQrBuffer(text) {
  try {
    return await QRCode.toBuffer(text || '-', {
      type:          'png',
      width:         140,
      margin:        1,
      color:         { dark: C.NAVY, light: '#FFFFFF00' },
    });
  } catch { return null; }
}

// ─── Section renderers ────────────────────────────────────────────────────────

async function renderHeader(doc, rx, logoBuffer, qrBuffer) {
  const TOP   = 45;
  const BOX_H = 80;   // height reserved for logo / QR
  const MID_X = MARGIN + BOX_H + 8;       // text start after logo
  const MID_W = CONTENT_W - BOX_H * 2 - 16; // text width (centre block)

  // ── Logo top-left ──
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, MARGIN, TOP, { fit: [BOX_H, BOX_H], align: 'center', valign: 'center' });
    } catch (_) { /* silently skip broken image */ }
  }

  // ── QR code top-right ──
  if (qrBuffer) {
    try {
      doc.image(qrBuffer, PAGE_W - MARGIN - BOX_H, TOP, { width: BOX_H, height: BOX_H });
    } catch (_) {}
  }

  // ── Clinic name — centred between logo and QR ──
  doc.font('Helvetica-Bold').fontSize(17).fillColor(C.TEAL)
     .text(rx.clinic_name || 'DentaFlow Clinic', MID_X, TOP + 2, {
       width: MID_W, align: 'center',
     });

  const addrLine = [rx.clinic_address, rx.clinic_city].filter(Boolean).join(', ');
  const contLine = [rx.clinic_phone, rx.clinic_email].filter(Boolean).join('  |  ');

  doc.font('Helvetica').fontSize(8).fillColor(C.GRAY)
     .text(addrLine, MID_X, doc.y + 3, { width: MID_W, align: 'center' })
     .text(contLine, MID_X, doc.y + 2, { width: MID_W, align: 'center' });

  // ── Doctor details — below QR, right-aligned ──
  const docName = [rx.doctor_first_name, rx.doctor_last_name].filter(Boolean).join(' ');
  const drY     = TOP + BOX_H + 4;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C.NAVY)
     .text(docName, PAGE_W - MARGIN - BOX_H, drY, { width: BOX_H, align: 'right' });
  if (rx.doctor_designation) {
    doc.font('Helvetica').fontSize(7.5).fillColor(C.GRAY)
       .text(rx.doctor_designation, PAGE_W - MARGIN - BOX_H, doc.y + 1, { width: BOX_H, align: 'right' });
  }

  const afterHeader = TOP + BOX_H + 28;
  hline(doc, afterHeader, C.TEAL, 1);
  return afterHeader + 10;
}

function renderPatientStrip(doc, rx, y) {
  const RCOL = PAGE_W - MARGIN - 140; // right column x

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.GRAY).text('PATIENT', MARGIN, y);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.NAVY)
     .text(rx.patient_name || '-', MARGIN, doc.y + 2);
  doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY)
     .text(rx.patient_phone || '', MARGIN, doc.y + 1);

  // Date & time — right side
  const dateStr = fmtDate(rx.created_at);
  const timeStr = fmtTime(rx.created_at);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.GRAY).text('DATE', RCOL, y);
  doc.font('Helvetica').fontSize(9).fillColor(C.NAVY).text(dateStr, RCOL, doc.y + 2);
  doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY).text(timeStr, RCOL, doc.y + 2);

  // Rx No — below date
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.MUTED)
     .text(`Rx No: ${rx.prescription_no}  ·  Valid: ${rx.valid_days} days`, RCOL, doc.y + 4);

  const lineY = Math.max(doc.y, y + 44) + 8;
  hline(doc, lineY);
  return lineY + 10;
}

function renderDiagnosis(doc, rx, y) {
  if (!rx.diagnosis && !rx.clinical_notes) return y;

  if (rx.diagnosis) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.GRAY).text('DIAGNOSIS', MARGIN, y);
    doc.font('Helvetica').fontSize(9.5).fillColor(C.NAVY)
       .text(rx.diagnosis, MARGIN, doc.y + 3, { width: CONTENT_W });
    y = doc.y + 6;
  }

  if (rx.clinical_notes) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.GRAY).text('CLINICAL NOTES', MARGIN, y);
    doc.font('Helvetica').fontSize(9).fillColor(C.NAVY)
       .text(rx.clinical_notes, MARGIN, doc.y + 3, { width: CONTENT_W });
    y = doc.y + 6;
  }

  hline(doc, y + 4);
  return y + 14;
}

function renderItems(doc, items, startY) {
  const medicines  = items.filter(i => i.item_type === 'medicine');
  const procedures = items.filter(i => i.item_type === 'procedure');
  let y = startY;

  // ── Medicines ──
  if (medicines.length) {
    // Large Rx symbol
    doc.font('Helvetica-Bold').fontSize(26).fillColor(C.TEAL).text('Rx', MARGIN, y);
    y = doc.y + 4;

    medicines.forEach((item, idx) => {
      if (y > PAGE_H - 170) { doc.addPage(); y = MARGIN + 10; }

      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.NAVY)
         .text(`${idx + 1}.  ${medTitle(item)}`, MARGIN + 14, y, { width: CONTENT_W - 14 });
      y = doc.y + 2;

      const detail = medDetail(item);
      if (detail) {
        doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY)
           .text(detail, MARGIN + 24, y, { width: CONTENT_W - 24 });
        y = doc.y + 2;
      }
      y += 6;
    });
  }

  // ── Procedures ──
  if (procedures.length) {
    if (y > PAGE_H - 170) { doc.addPage(); y = MARGIN + 10; }
    y += 4;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.NAVY).text('Procedures', MARGIN, y);
    y = doc.y + 6;

    procedures.forEach((item, idx) => {
      if (y > PAGE_H - 170) { doc.addPage(); y = MARGIN + 10; }

      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.NAVY)
         .text(`${idx + 1}.  ${procTitle(item)}`, MARGIN + 14, y, { width: CONTENT_W - 14 });
      y = doc.y + 2;

      const detail = procDetail(item);
      if (detail) {
        doc.font('Helvetica').fontSize(8.5).fillColor(C.GRAY)
           .text(detail, MARGIN + 24, y, { width: CONTENT_W - 24 });
        y = doc.y + 2;
      }
      y += 6;
    });
  }

  if (!medicines.length && !procedures.length) {
    doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text('No items added.', MARGIN, y);
    y = doc.y + 6;
  }

  return y;
}

function renderSignature(doc, rx, y) {
  // Nudge to safe area above footer (footer occupies bottom 54 pt)
  const SIG_Y = PAGE_H - 120;
  if (y < SIG_Y) y = SIG_Y;

  hline(doc, y, C.LIGHT, 0.5);
  y += 12;

  const sigLineX1 = PAGE_W - MARGIN - 150;
  const sigLineX2 = PAGE_W - MARGIN;
  const sigLineY  = y + 38;

  // Signature placeholder box
  doc.save()
     .rect(sigLineX1, y, 150, 40)
     .dash(3, { space: 3 })
     .strokeColor(C.LIGHT).lineWidth(0.5).stroke()
     .restore();

  doc.font('Helvetica').fontSize(7.5).fillColor(C.MUTED)
     .text('(Signature)', sigLineX1, y + 14, { width: 150, align: 'center' });

  // Solid signature line
  doc.moveTo(sigLineX1, sigLineY).lineTo(sigLineX2, sigLineY)
     .strokeColor(C.GRAY).lineWidth(0.5).stroke();

  const docName = [rx.doctor_first_name, rx.doctor_last_name].filter(Boolean).join(' ');
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.NAVY)
     .text(docName, sigLineX1, sigLineY + 5, { width: 150, align: 'center' });

  if (rx.doctor_designation) {
    doc.font('Helvetica').fontSize(8).fillColor(C.GRAY)
       .text(rx.doctor_designation, sigLineX1, doc.y + 2, { width: 150, align: 'center' });
  }
}

function renderFooter(doc, rx) {
  const FOOTER_H = 38;
  const fy       = PAGE_H - FOOTER_H;

  // Teal background strip — bleeds to page edges
  doc.save()
     .rect(0, fy, PAGE_W, FOOTER_H)
     .fill(C.TEAL_DARK)
     .restore();

  // Thin accent line at top of footer
  doc.save()
     .moveTo(0, fy).lineTo(PAGE_W, fy)
     .strokeColor(C.TEAL).lineWidth(1.5).stroke()
     .restore();

  const parts = [
    rx.clinic_name,
    [rx.clinic_address, rx.clinic_city].filter(Boolean).join(', '),
    rx.clinic_phone,
    rx.clinic_email,
  ].filter(Boolean);

  doc.font('Helvetica').fontSize(7.5).fillColor(C.WHITE)
     .text(parts.join('  ·  '), MARGIN, fy + 8, {
       width:   CONTENT_W,
       align:   'center',
       lineGap: 0,
     });

  doc.font('Helvetica').fontSize(6.5).fillColor('#A7F3D0')
     .text('This is a computer-generated prescription. Valid for ' + (rx.valid_days || 7) + ' days from date of issue.',
       MARGIN, fy + 22, { width: CONTENT_W, align: 'center' });
}

// ─── Main build function ──────────────────────────────────────────────────────

async function build(rx, { logoBuffer } = {}) {
  const qrText   = `${process.env.BOOKING_FORM_URL || 'https://dentaflow.app'}/rx/verify/${rx.prescription_no}`;
  const qrBuffer = await buildQrBuffer(qrText);

  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: MARGIN, autoFirstPage: true });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    (async () => {
      try {
        let y = await renderHeader(doc, rx, logoBuffer, qrBuffer);
        y = renderPatientStrip(doc, rx, y);
        y = renderDiagnosis(doc, rx, y);
        y = renderItems(doc, rx.line_items || [], y);
        renderSignature(doc, rx, y);
        renderFooter(doc, rx);
        doc.end();
      } catch (err) {
        reject(err);
      }
    })();
  });
}

module.exports = { build };
