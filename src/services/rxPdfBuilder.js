const PDFDocument = require('pdfkit');

const LOGO_FETCH_TIMEOUT_MS = 5000;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

function line(doc, y) {
  doc
    .moveTo(50, y)
    .lineTo(545, y)
    .strokeColor('#D1D5DB')
    .stroke();
}

function writeField(doc, label, value, x, y) {
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor('#374151')
    .text(label, x, y, { continued: true })
    .font('Helvetica')
    .fillColor('#111827')
    .text(` ${value || '-'}`);
}

function formatDate(date) {
  if (!date) return '-';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(date));
}

function itemTitle(item) {
  if (item.item_type === 'medicine') {
    const parts = [item.medicine_name, item.medicine_strength].filter(Boolean);
    return parts.join(' ');
  }
  return item.procedure_name || item.procedure_code || 'Procedure';
}

function itemDetails(item) {
  if (item.item_type === 'procedure') {
    return [
      item.procedure_status ? `Status: ${item.procedure_status}` : null,
      item.instructions || item.default_notes,
    ].filter(Boolean).join(' | ');
  }

  return [
    item.dosage,
    item.frequency,
    item.duration,
    item.quantity ? `Qty: ${item.quantity}` : null,
    item.instructions,
  ].filter(Boolean).join(' | ');
}

async function fetchLogoBuffer(logoUrl) {
  if (!logoUrl) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(logoUrl, { signal: controller.signal });

      if (!response.ok) return null;

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('svg')) return null;

      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > MAX_LOGO_BYTES) return null;

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_LOGO_BYTES) return null;

      return Buffer.from(arrayBuffer);
    } finally {
      clearTimeout(timeout);
    }
  } catch (_) {
    return null;
  }
}

function renderHeader(doc, rx, logoBuffer) {
  const headerTop = 50;

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, 50, headerTop, {
        fit: [72, 72],
        align: 'center',
        valign: 'center',
      });
    } catch (_) {
      logoBuffer = null;
    }
  }

  const textX = logoBuffer ? 138 : 50;
  const textWidth = logoBuffer ? 407 : 495;

  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor('#0F172A')
    .text(rx.clinic_name || 'DentaFlow Clinic', textX, headerTop + 5, {
      width: textWidth,
      align: logoBuffer ? 'left' : 'center',
    });

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#4B5563')
    .text([rx.clinic_phone, rx.clinic_email].filter(Boolean).join(' | '), textX, doc.y + 4, {
      width: textWidth,
      align: logoBuffer ? 'left' : 'center',
    })
    .text([rx.clinic_address, rx.clinic_city].filter(Boolean).join(', '), {
      width: textWidth,
      align: logoBuffer ? 'left' : 'center',
    });

  doc.y = Math.max(doc.y, headerTop + (logoBuffer ? 82 : 52));
  line(doc, doc.y);
  doc.moveDown();
}

async function build(rx) {
  const logoBuffer = await fetchLogoBuffer(rx.clinic_logo_url);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    renderHeader(doc, rx, logoBuffer);

    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor('#0D7A5F')
      .text('Prescription');

    const infoY = doc.y + 8;
    writeField(doc, 'Rx No:', rx.prescription_no, 50, infoY);
    writeField(doc, 'Date:', formatDate(rx.created_at), 360, infoY);
    writeField(doc, 'Patient:', rx.patient_name, 50, infoY + 18);
    writeField(doc, 'Phone:', rx.patient_phone, 360, infoY + 18);
    writeField(doc, 'Doctor:', [rx.doctor_first_name, rx.doctor_last_name].filter(Boolean).join(' '), 50, infoY + 36);
    writeField(doc, 'Valid Days:', rx.valid_days, 360, infoY + 36);

    doc.y = infoY + 68;
    if (rx.diagnosis) {
      writeField(doc, 'Diagnosis:', rx.diagnosis, 50, doc.y);
      doc.moveDown();
    }
    if (rx.clinical_notes) {
      writeField(doc, 'Clinical Notes:', rx.clinical_notes, 50, doc.y);
      doc.moveDown();
    }

    line(doc, doc.y + 6);
    doc.moveDown();

    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor('#111827')
      .text('Items', 50, doc.y + 8);

    doc.moveDown(0.5);

    const items = rx.line_items || [];
    if (!items.length) {
      doc.font('Helvetica').fontSize(10).fillColor('#4B5563').text('No line items.');
    }

    items.forEach((item, index) => {
      if (doc.y > 720) doc.addPage();
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#111827')
        .text(`${index + 1}. ${itemTitle(item)}`, 50, doc.y);

      const details = itemDetails(item);
      if (details) {
        doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor('#4B5563')
          .text(details, 68, doc.y + 2, { width: 460 });
      }
      doc.moveDown(0.8);
    });

    doc.moveDown();
    line(doc, doc.y);
    doc
      .moveDown()
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#6B7280')
      .text('This is a digitally generated prescription.', { align: 'center' });

    doc.end();
  });
}

module.exports = { build };
