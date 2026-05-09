const https = require('https');

const BASE_URL = 'https://www.fast2sms.com/dev/bulkV2';

/**
 * Sends a 6-digit OTP via Fast2SMS Quick SMS route.
 * Route 'q' works after a ₹100 recharge with no extra verification required.
 *
 * @param {string} phone  10-digit Indian mobile (no country code)
 * @param {string} otp    6-digit code
 * @returns {Promise<{ success: boolean, requestId?: string, error?: string, providerCode?: number }>}
 */
async function sendOtp(phone, otp) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) {
    console.warn('[fast2sms] FAST2SMS_API_KEY not set — OTP skipped (dev mode)');
    return { success: true, requestId: 'dev-skip' };
  }

  const message = `Your DentaFlow Login OTP is ${otp}. Valid for 10 minutes. Do not share this code with anyone.`;

  const body = JSON.stringify({
    route:    'q',
    message,
    language: 'english',
    flash:    0,
    numbers:  phone,
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'www.fast2sms.com',
        path:     '/dev/bulkV2',
        method:   'POST',
        headers: {
          authorization:    apiKey,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.return === true) {
              resolve({ success: true, requestId: data.request_id });
            } else {
              const providerCode = data.status_code;
              const providerMsg  = Array.isArray(data.message)
                ? data.message[0]
                : (data.message ?? 'Provider error');
              console.error(`[fast2sms] send failed (${providerCode}):`, providerMsg);
              resolve({ success: false, error: providerMsg, providerCode });
            }
          } catch {
            console.error('[fast2sms] unparseable response:', raw);
            resolve({ success: false, error: 'Invalid response from SMS provider' });
          }
        });
      }
    );
    req.on('error', (err) => {
      console.error('[fast2sms] request error:', err.message);
      resolve({ success: false, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

module.exports = { sendOtp };
