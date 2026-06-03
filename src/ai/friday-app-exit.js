// Friday — voice logout: end session + route user to login (frontend clears tokens).

const { hashToken } = require('../auth/jwt.service');
const { getTimeContext } = require('./friday-time');

const LOGIN_REDIRECT = process.env.FRONTEND_LOGIN_PATH || '/authentication/login';

const APP_EXIT_RX = /\b(?:log\s*out(?:\s+of)?\s+(?:the\s+)?(?:app|application)?|logout|log\s*out|log\s*off|logging\s+off|exit\s+(?:the\s+)?(?:app|application)|close\s+(?:the\s+)?(?:app|application)|quit\s+(?:the\s+)?(?:app|application)|leave\s+(?:the\s+)?(?:app|application)|close\s+friday|stop\s+friday|exit\s+friday|quit\s+friday|get\s+out\s+of\s+(?:the\s+)?app|log\s*me\s+out)\b/i;

const LEAVING_EARLY_RX = /\b(?:leaving\s+early|leave\s+early|going\s+home\s+early|clock(?:ing)?\s+out\s+early|done\s+early|half\s+day|heading\s+out\s+early|out\s+early|packing\s+up\s+early|leave\s+before\s+(?:five|5|closing|schedule)|calling\s+it\s+a\s+day\s+early|sneaking\s+out\s+early|early\s+exit|ducking\s+out\s+early)\b/i;

const ACCOUNT_SIGNOUT_RX = /\b(?:sign\s*out(?:\s+of)?\s+(?:my\s+)?account|log\s*out\s+of\s+(?:my\s+)?account|end\s+(?:my\s+)?session|sign\s*me\s+out\s+completely)\b/i;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isAppExitUtterance(text) {
  const t = String(text || '');
  return APP_EXIT_RX.test(t) || LEAVING_EARLY_RX.test(t) || ACCOUNT_SIGNOUT_RX.test(t);
}

function isAccountSignOutUtterance(text) {
  return ACCOUNT_SIGNOUT_RX.test(String(text || ''));
}

function appExitReason(text) {
  if (LEAVING_EARLY_RX.test(String(text || ''))) return 'leaving_early';
  if (ACCOUNT_SIGNOUT_RX.test(String(text || ''))) return 'sign_out';
  return 'exit_app';
}

function appExitTone(text) {
  const t = String(text || '').toLowerCase();
  if (LEAVING_EARLY_RX.test(t)) return 'sarcastic';
  if (/\b(fine|whatever|just|already|enough|ugh|finally|about time|ok ok|please just|yeah yeah|sure sure)\b/.test(t)) {
    return 'sarcastic';
  }
  if (/\b(bye|goodbye|see you|done for today)\b/.test(t)) return 'sarcastic';
  return 'direct';
}

function sarcasticLeavingEarly(ctx) {
  const time = ctx.time_label;
  return pick([
    `Leaving early at ${time}? Fine — logging you out and sending you to login.`,
    `Half-day at ${time}? Bold. Session ended — login page is next.`,
    `Early exit at ${time}? OK boss. You're out — see you after you sign in again.`,
    `Clocking out early? Logout done. Go home; the login screen awaits.`,
    `Heading out early? Fine. I've logged you out — don't chart from the car park.`,
  ]);
}

function sarcasticExitApp(ctx) {
  return pick([
    'Fine. Logging you out — taking you to the login page now.',
    `Alright, out at ${ctx.time_label}. Session cleared — login screen next.`,
    'Whatever you say. Logged out — redirecting to login.',
    'OK boss. You\'re logged out. Login page loading.',
  ]);
}

function directExitApp() {
  return pick([
    'Logging you out now — redirecting to login.',
    'Logout complete. Taking you to the login page.',
    'Signed out. See you next time — login when you return.',
  ]);
}

function appExitMessage(tone, reason, ctx = getTimeContext()) {
  if (tone === 'sarcastic' && reason === 'leaving_early') return sarcasticLeavingEarly(ctx);
  if (tone === 'sarcastic') return sarcasticExitApp(ctx);
  if (reason === 'leaving_early') {
    return `Logging you out — leaving early at ${ctx.time_label}. Redirecting to login.`;
  }
  return directExitApp();
}

/** Frontend must clear tokens and navigate to redirect. */
function buildLogoutAction(tone, reason) {
  return {
    type:               'logout',
    redirect:           LOGIN_REDIRECT,
    revoke_session:     true,
    clear_local_auth:   true,
    reason,
    tone,
  };
}

async function performAppLogout(userId, refreshToken) {
  const db = require('../db');
  if (refreshToken) {
    await db.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [hashToken(refreshToken)]);
    return { performed: true, revoked: 'token' };
  }
  if (userId) {
    const r = await db.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
    return { performed: true, revoked: 'all_sessions', count: r.rowCount };
  }
  return { performed: false, revoked: 'none' };
}

module.exports = {
  isAppExitUtterance,
  isAccountSignOutUtterance,
  appExitReason,
  appExitTone,
  appExitMessage,
  buildLogoutAction,
  performAppLogout,
  LOGIN_REDIRECT,
};
