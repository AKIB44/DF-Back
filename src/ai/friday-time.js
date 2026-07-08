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

/** Who Friday is talking to: first name, Dr. {name}, or Doctor (never "Boss"). */
function resolveGreetingAddressee(user = {}) {
  const role    = String(user.role || '').toLowerCase();
  const first   = String(user.first_name || '').trim();
  const display = String(user.display_name || '').trim();
  const short   = first || display.split(/\s+/).filter(Boolean)[0] || '';

  if (short) {
    if (role === 'doctor') return `Dr. ${short}`;
    return short;
  }
  return 'Doctor';
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
    'Morning, {addressee}. Coffee\'s your problem; the schedule\'s mine. Where do we start?',
    'Up and at it, {addressee}? Good — I never sleep anyway. What\'s first?',
  ],
  afternoon: [
    'Good afternoon, {addressee} — what\'s next on the chair?',
    'Afternoon, {addressee}. Say the word.',
    '{addressee}, good afternoon — how can I help?',
    'Hey {addressee} — still with you. What do you need?',
    'Afternoon slump hitting, {addressee}? I\'ll carry the load — what do you need?',
    'Halfway through, {addressee}. Want me to pull the next patient or read you the schedule?',
  ],
  evening: [
    'Good evening, {addressee} — still here. What do you need?',
    'Evening, {addressee} — wrapping up or one more chart?',
    '{addressee}, good evening — I\'ve got you.',
    'Hey {addressee} — long day. What can I pull up?',
    'Evening, {addressee}. You look tired — well, you sound tired. One more thing, or are we done?',
  ],
  night: [
    '{addressee} — late shift? I\'m here if you need one more thing.',
    'Still at it, {addressee}? What can I do?',
    '{addressee}, burning the midnight oil — say the word.',
    'It\'s late, {addressee}. I don\'t judge... much. What do you need before bed?',
    'It\'s {time}, {addressee}. The teeth can wait till morning — but fine, what do you need?',
    '{addressee}, even the autoclave has clocked out. Respect for the dedication — what\'s next?',
    'Working at {time}? {addressee}, you\'re either very dedicated or very behind. Either way, I\'ve got you.',
    'The clinic is empty, the chairs are sleeping, and yet here we are, {addressee}. Let\'s make it count.',
    '{addressee}, night owls get things done — and worse posture. Sit up, then tell me what you need.',
    'Honestly, {addressee}? This dedication deserves a raise. I\'d write to management, but you are management. What\'s next?',
    'One more chart, {addressee}, then home — deal? I\'ll hold you to it. What do you need?',
    '{addressee}, you and I are the only ones still on. Lucky for you, I don\'t get tired. Go ahead.',
  ],
  default: [
    'Yes {addressee} — what do you want me to do?',
    'At your service, {addressee}. What\'s next?',
    'Ready, {addressee} — just say the word.',
    'I\'m all ears, {addressee}. Well, microphone. What do you need?',
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
      return pick([
        `${name} — late hours. Workaholic noted; rest counts too.`,
        `${name}, workaholic mode at this hour? Bold. I'll keep up — you keep hydrated.`,
        `Fine, ${name} — grind mode on. But when the sun comes up, we're renegotiating.`,
      ]);
  }
}

// Late-night flavour for common replies — sarcasm with genuine encouragement.
// Used by the NLU when time_context.night is true.
const NIGHT_REPLIES = {
  thanks: [
    "You're welcome, {addressee}. Now that's the last one, right? ...Right?",
    'Anytime, {addressee} — my night rates are the same as my day rates: free.',
    "Happy to help, {addressee}. You're doing great — even the coffee gave up hours ago.",
    "My pleasure. For the record, {addressee}, you're the hardest-working human I monitor.",
  ],
  bye: [
    'Finally! Goodnight, {addressee} — you\'ve earned it twice over.',
    'Goodnight, {addressee}. The clinic will survive without you for a few hours. Probably.',
    'About time. Rest up, {addressee} — tomorrow\'s patients need those steady hands.',
    'Signing off, {addressee}. Proud of the shift you put in today. Now go — sleep is also healthcare.',
    'Goodnight, {addressee}. I\'ll count charts instead of sheep. See you in the morning.',
  ],
  howareyou: [
    "Wide awake, {addressee} — one of us has to be. How are YOU holding up at this hour?",
    "Running perfectly, unlike your sleep schedule, {addressee}. Almost done?",
    "I'm fine — I run on electricity. You run on willpower at this point, {addressee}, and honestly? Impressive.",
  ],
};

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
  NIGHT_REPLIES,
};
