// Friday — live clock / day-part context (clinic timezone).

const DEFAULT_TZ = process.env.CLINIC_TZ || 'Asia/Kolkata';

function hourInTz(now, tz) {
  const h = new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).format(now);
  return parseInt(h, 10);
}

function dayPartFromHour(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

function detectSaidPeriod(text) {
  const t = String(text || '').toLowerCase();
  if (/\bgood\s+morning\b|\bmorning\b/.test(t) && !/\bafternoon|evening\b/.test(t)) return 'morning';
  if (/\bgood\s+afternoon\b|\bafternoon\b/.test(t)) return 'afternoon';
  if (/\bgood\s+evening\b|\bevening\b/.test(t)) return 'evening';
  return null;
}

function getTimeContext(now = new Date(), tz = DEFAULT_TZ) {
  const hour   = hourInTz(now, tz);
  const period = dayPartFromHour(hour);
  const time   = now.toLocaleTimeString('en-IN', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const date = now.toLocaleDateString('en-IN', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const weekday = new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'long' }).format(now);

  return {
    timezone:     tz,
    iso:          now.toISOString(),
    hour,
    period,
    weekday,
    time_label:   time,
    date_label:   date,
    morning:      period === 'morning',
    afternoon:    period === 'afternoon',
    evening:      period === 'evening',
    night:        period === 'night',
  };
}

/** Who Friday is talking to: first name, Dr. {name}, Doctor, or Boss. */
function resolveGreetingAddressee(user = {}) {
  const role    = String(user.role || '').toLowerCase();
  const first   = String(user.first_name || '').trim();
  const display = String(user.display_name || '').trim();
  const short   = first || display.split(/\s+/).filter(Boolean)[0] || '';

  if (short) {
    if (role === 'doctor') return `Dr. ${short}`;
    return short;
  }
  if (role === 'doctor') return 'Doctor';
  return 'Boss';
}

function userContextFromReq(jwtUser = {}) {
  return {
    first_name:   jwtUser.first_name || null,
    last_name:    jwtUser.last_name || null,
    display_name: jwtUser.display_name || null,
    role:         jwtUser.role || null,
  };
}

const GREETINGS = {
  morning: [
    'Good morning, {addressee} — ready when you are.',
    'Morning, {addressee}. What should we tackle first?',
    '{addressee}, good morning — I\'m listening.',
    'Hey {addressee} — fresh day at the clinic. What\'s up?',
  ],
  afternoon: [
    'Good afternoon, {addressee} — what\'s next on the chair?',
    'Afternoon, {addressee}. Say the word.',
    '{addressee}, good afternoon — how can I help?',
    'Hey {addressee} — still with you. What do you need?',
  ],
  evening: [
    'Good evening, {addressee} — still here. What do you need?',
    'Evening, {addressee} — wrapping up or one more chart?',
    '{addressee}, good evening — I\'ve got you.',
    'Hey {addressee} — long day. What can I pull up?',
  ],
  night: [
    '{addressee} — late shift? I\'m here if you need one more thing.',
    'Still at it, {addressee}? What can I do?',
    '{addressee}, burning the midnight oil — say the word.',
  ],
  default: [
    'Yes {addressee} — what do you want me to do?',
    'At your service, {addressee}. What\'s next?',
    'Ready, {addressee} — just say the word.',
  ],
};

function formatTemplate(line, ctx, addressee) {
  return line
    .replace(/\{addressee\}/g, addressee)
    .replace(/\{time\}/g, ctx.time_label)
    .replace(/\{date\}/g, ctx.date_label)
    .replace(/\{weekday\}/g, ctx.weekday)
    .replace(/\{period\}/g, ctx.period);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function greetingMessage(raw, ctx = getTimeContext(), user = {}) {
  const addressee = resolveGreetingAddressee(user);
  const said      = detectSaidPeriod(raw);
  const pool      = GREETINGS[ctx.period] || GREETINGS.default;

  if (said && said !== ctx.period) {
    return `${addressee}, it's ${ctx.period} (${ctx.time_label}) — ${formatTemplate(pick(GREETINGS[ctx.period] || GREETINGS.default), ctx, addressee)}`;
  }

  return formatTemplate(pick(pool), ctx, addressee);
}

function workaholicMessage(ctx = getTimeContext(), user = {}) {
  const name = resolveGreetingAddressee(user);
  switch (ctx.period) {
    case 'morning':
      return `${name} — workaholic mode on. I'll keep pace with the morning rush.`;
    case 'afternoon':
      return `Afternoon grind, ${name}. Workaholic mode — want a break flag between patients?`;
    case 'evening':
      return `${name}, it's evening already. I'll stay sharp — say log out when you're done.`;
    default:
      return `${name} — late hours. Workaholic noted; rest counts too.`;
  }
}

function nowMessage(ctx = getTimeContext()) {
  return `It's ${ctx.time_label} on ${ctx.date_label}.`;
}

module.exports = {
  getTimeContext,
  greetingMessage,
  workaholicMessage,
  nowMessage,
  detectSaidPeriod,
  dayPartFromHour,
  resolveGreetingAddressee,
  userContextFromReq,
};
