'use strict';

// Cloudflare Turnstile server-side verification.
//
// Config (env):
//   TURNSTILE_SECRET_KEY  — the secret key (server side). When unset, captcha is
//                           DISABLED so local/dev and un-provisioned environments
//                           keep working; login simply skips the check.
//   TURNSTILE_SITE_KEY    — the public site key, served to the browser via
//                           GET /v1/auth/config so the widget can render.
//
// The frontend sends the widget token as `captcha_token`; we exchange it with
// Cloudflare's siteverify endpoint together with the secret.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Captcha is only enforced when a secret key is configured. */
function isEnabled() {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

/** The public site key (safe to expose to the browser), or null when disabled. */
function siteKey() {
  return process.env.TURNSTILE_SITE_KEY || null;
}

/**
 * Verify a Turnstile token with Cloudflare.
 * @param {string} token  the `cf-turnstile-response` from the widget
 * @param {string} [remoteip]  the client IP (optional, improves scoring)
 * @returns {Promise<boolean>} true only when Cloudflare confirms success
 */
async function verify(token, remoteip) {
  if (!isEnabled()) return true;        // not configured → nothing to enforce
  if (!token) return false;

  const body = new URLSearchParams();
  body.append('secret', process.env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (remoteip) body.append('remoteip', remoteip);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await resp.json();
    return data.success === true;
  } catch (err) {
    // Network/timeout talking to Cloudflare — fail closed so the captcha can't be
    // bypassed by knocking out the verifier.
    console.error('[turnstile] verification error:', err.message);
    return false;
  }
}

module.exports = { isEnabled, siteKey, verify };
