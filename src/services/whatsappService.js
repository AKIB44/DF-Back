'use strict';

// WhatsApp Message Center broadcast for the Marketing module (PRD §10 integration).
//
// DentaFlow has no WhatsApp BSP wired yet, so this runs in STUB mode: it validates
// recipients and reports a sent/failed count so the campaign → broadcast flow works
// end-to-end, without actually messaging anyone. Flip WHATSAPP_ENABLED=true and
// replace the stub with a real BSP call (Gupshup / Meta Cloud API / etc.) once a
// provider is configured. (PRD §14 Q5: WA-vs-in-app for notifications.)

const ENABLED = process.env.WHATSAPP_ENABLED === 'true';

function isEnabled() {
  return ENABLED;
}

/**
 * Broadcast a templated message to a list of phone numbers.
 * @param {{ recipients: string[], template?: string, body?: string }} opts
 * @returns {{ provider, sent, failed, status }}
 */
async function broadcast({ recipients = [] }) {
  const valid = recipients.filter((p) => typeof p === 'string' && p.replace(/\D/g, '').length >= 10);
  if (!ENABLED) {
    // Stub: pretend every valid recipient was queued.
    return { provider: 'stub', sent: valid.length, failed: recipients.length - valid.length, status: 'queued' };
  }
  // TODO: real BSP call — segment the list into batches, send template, collect ids.
  throw new Error('WhatsApp broadcast not configured');
}

module.exports = { isEnabled, broadcast };
