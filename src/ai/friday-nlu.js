// ────────────────────────────────────────────────────────────────────────────
// Friday NLU — local intent classifier (zero external cost)
// ────────────────────────────────────────────────────────────────────────────
//
// Training source priority:
//   1. back/data/friday-training.json    (preferred — iterate freely, no rebuild)
//   2. Inline TRAINING_DATA fallback     (used if the JSON is missing/bad)
//
// Iteration loop:
//   - Add phrases to friday-training.json
//   - `node scripts/test-friday.js "your phrase"` to score it
//   - Restart backend → new model picks up
//
// Unknown / low-confidence utterances are appended to data/friday-misses.log
// for later review and promotion into the training set.
// ────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const {
  getTimeContext,
  greetingMessage,
  workaholicMessage,
  nowMessage,
  detectSaidPeriod,
  NIGHT_REPLIES,
} = require('./friday-time');
const {
  isAppExitUtterance,
  isAccountSignOutUtterance,
  appExitReason,
  appExitTone,
  appExitMessage,
  buildLogoutAction,
} = require('./friday-app-exit');
const convo = require('./friday-context');

const TRAINING_FILE = path.join(__dirname, '..', '..', 'data', 'friday-training.json');
const MISSES_LOG    = path.join(__dirname, '..', '..', 'data', 'friday-misses.log');

function loadTrainingFromFile() {
  try {
    const raw = fs.readFileSync(TRAINING_FILE, 'utf8');
    const json = JSON.parse(raw);
    const out = { data: {}, meta: {} };
    for (const k of Object.keys(json)) {
      if (k.startsWith('_')) {
        if (k === '_meta' && json[k] && typeof json[k] === 'object') out.meta = json[k];
        continue;
      }
      if (Array.isArray(json[k])) out.data[k] = json[k];
    }
    return Object.keys(out.data).length ? out : null;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[friday-nlu] training file unreadable:', e.message);
    return null;
  }
}

const INLINE_TRAINING = {
  'patient.find': [
    'open patient ravi',
    'show patient ravi sharma',
    'find patient asha',
    'search patient by name',
    'lookup patient ravi',
    'pull up patient record',
    'open record of asha mehta',
    'show me ravi sharma',
    'find ravi',
    'patient ravi please',
    'i want to see ravi sharma',
    'open the file of asha',
    'patient record for ravi',
    'pull up 9876543210',
    'find phone 9876543210',
    'search 98765',
    'look up the patient asha mehta',
    'who is ravi sharma',
    'show details for patient',
    'open patient file',
    'get me ravi sharma record',
    'fetch patient asha',
    'patient lookup ravi',
    'search for ravi sharma',
    'bring up the patient record',
  ],
  'billing.patient': [
    'how much does paras owe',
    'due amount for paras',
    'what is paras final amount',
    'patient paras balance due',
    'outstanding bill for ravi sharma',
    'total bill for asha mehta',
    'how much is patient paras due',
    'check billing balance for ravi',
    'payment due for paras gupta',
    'show paras outstanding amount',
  ],
  'navigate': [
    'go to schedule',
    'open schedule',
    'show schedule',
    'open todays schedule',
    'take me to schedule',
    'open booking',
    'go to booking',
    'new appointment page',
    'open new appointment',
    'show patients list',
    'open patients',
    'go to patients',
    'open inventory',
    'show inventory',
    'go to inventory',
    'open labs',
    'show lab orders',
    'lab orders page',
    'open treatment plans',
    'go to treatment plans',
    'show prescriptions',
    'open prescriptions',
    'open rx',
    'go to specialty',
    'show specialty modules',
    'open settings',
    'show settings',
    'go to settings page',
    'take me to dashboard',
    'open the dashboard',
  ],
  'appointment.book': [
    'book a cleaning for ravi',
    'book an appointment',
    'schedule a cleaning',
    'create new appointment for ravi',
    'book root canal for ravi',
    'schedule extraction for asha',
    'book appointment for ravi tomorrow',
    'new booking for asha mehta',
    'book filling for patient',
    'schedule a checkup',
    'book a consultation',
    'book a scaling for ravi at 10am',
    'create appointment ravi',
    'add appointment for asha',
    'schedule cleaning at 4 pm',
    'new appointment for tomorrow',
    'book ravi for cleaning at 10',
    'set up an appointment for asha',
    'i want to book for ravi sharma',
    'book whitening for asha tomorrow',
  ],
  'schedule.summary': [
    'whats on today',
    'how many patients today',
    'todays appointments',
    'todays summary',
    'show todays appointments count',
    'how many bookings today',
    'how busy are we today',
    'patients scheduled today',
    'how many appointments do i have',
    'whats my schedule today',
    'todays patient count',
    'summary of today',
    'tell me todays load',
    'todays booking count',
    'how many in the chair today',
    'rundown of today',
    'todays workload',
  ],
};

// ── Tokenization ────────────────────────────────────────────────────────────
// NOTE: 'today' / 'now' / 'tomorrow' are deliberately NOT stop words — they are
// the discriminating tokens for schedule intents ("what's on today" must keep
// "today" or its vector collapses to nothing).
const STOP_WORDS = new Set([
  'a','an','the','to','of','for','at','on','in','is','am','are','my','i','we','our',
  'please','could','can','you','me','do','have','has','any','some','this','that','it',
  'just','really','quickly','fast','okay','ok','well','hi','hello','hey',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 1 && !STOP_WORDS.has(t));
}

// ── Build TF-IDF model from training data ──────────────────────────────────
function buildModel(data) {
  const intents = Object.keys(data);
  const docs    = [];
  const labels  = [];
  for (const intent of intents) {
    for (const phrase of data[intent]) {
      docs.push(tokenize(phrase));
      labels.push(intent);
    }
  }
  // Document frequency
  const df = new Map();
  for (const doc of docs) {
    const unique = new Set(doc);
    for (const term of unique) df.set(term, (df.get(term) || 0) + 1);
  }
  const N = docs.length;
  const idf = new Map();
  for (const [term, freq] of df) {
    // Smoothed IDF
    idf.set(term, Math.log((N + 1) / (freq + 1)) + 1);
  }
  // Per-intent centroid vector (averaged TF-IDF across phrases)
  const centroids = new Map();
  for (const intent of intents) {
    const vec = new Map();
    let count = 0;
    for (let i = 0; i < docs.length; i++) {
      if (labels[i] !== intent) continue;
      const doc = docs[i];
      if (!doc.length) continue;
      count++;
      const tf = new Map();
      for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, f] of tf) {
        const w = (f / doc.length) * (idf.get(t) || 0);
        vec.set(t, (vec.get(t) || 0) + w);
      }
    }
    if (count > 0) for (const t of vec.keys()) vec.set(t, vec.get(t) / count);
    centroids.set(intent, vec);
  }
  return { idf, centroids, intents, data };
}

const SCORE_CENTROID_WEIGHT = 0.30;
const SCORE_PHRASE_WEIGHT   = 0.70;

function scoreIntent(vec, intent, model) {
  const centroidScore = cosine(vec, model.centroids.get(intent));
  let bestPhraseScore = 0;
  for (const phrase of model.data[intent]) {
    const pt = tokenize(phrase);
    if (!pt.length) continue;
    bestPhraseScore = Math.max(bestPhraseScore, cosine(vec, vectorize(pt, model.idf)));
  }
  return SCORE_CENTROID_WEIGHT * centroidScore + SCORE_PHRASE_WEIGHT * bestPhraseScore;
}

function vectorize(tokens, idf) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const vec = new Map();
  for (const [t, f] of tf) {
    const w = idf.get(t);
    if (!w) continue; // unseen term — skip
    vec.set(t, (f / tokens.length) * w);
  }
  return vec;
}

// ── Fuzzy matching — speech recognition mangles words ("shedule", "inventary",
// "pashent"). For unseen query tokens, map to the closest vocabulary term
// within a tight edit distance and use it at a small weight penalty.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1; // early exit — row can't recover
    prev = cur;
  }
  return prev[b.length];
}

function nearestVocabTerm(token, idf) {
  if (token.length < 4) return null;              // too short to fuzz safely
  const maxDist = token.length >= 7 ? 2 : 1;
  let best = null, bestDist = maxDist + 1;
  for (const term of idf.keys()) {
    if (Math.abs(term.length - token.length) > maxDist) continue;
    if (term[0] !== token[0]) continue;           // anchor first letter — cheap + accurate for ASR errors
    const d = editDistance(token, term, maxDist);
    if (d < bestDist) { bestDist = d; best = term; if (d === 1) break; }
  }
  return best;
}

/** Query-side vectorizer: unseen tokens fall back to their nearest vocab term. */
function vectorizeQuery(tokens, idf) {
  const mapped = tokens.map(t => {
    if (idf.has(t)) return t;
    return nearestVocabTerm(t, idf) || t;
  });
  return vectorize(mapped, idf);
}

/**
 * Rewrite an utterance replacing out-of-vocabulary words with their nearest
 * vocab term ("shedule" → "schedule"). Used to retry entity extraction when
 * the classifier is confident but the extractor can't parse the raw text.
 * Never applied by default — it could corrupt unusual patient names.
 */
function fuzzyCorrect(text, idf) {
  return String(text)
    .toLowerCase()
    .split(/\s+/)
    .map(w => {
      const clean = w.replace(/[^a-z0-9]/g, '');
      if (!clean || clean.length < 4 || idf.has(clean)) return w;
      return nearestVocabTerm(clean, idf) || w;
    })
    .join(' ');
}

function cosine(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const small = a.size < b.size ? a : b;
  const big   = small === a ? b : a;
  let dot = 0;
  for (const [t, w] of small) {
    const bw = big.get(t);
    if (bw) dot += w * bw;
  }
  let na = 0, nb = 0;
  for (const w of a.values()) na += w * w;
  for (const w of b.values()) nb += w * w;
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const LOADED           = loadTrainingFromFile();
const ACTIVE_TRAINING  = LOADED?.data || INLINE_TRAINING;
const TRAINING_META    = LOADED?.meta || {};
const MODEL            = buildModel(ACTIVE_TRAINING);
console.log(`[friday-nlu] model loaded — ${Object.keys(ACTIVE_TRAINING).length} intents, ${Object.values(ACTIVE_TRAINING).reduce((s, arr) => s + arr.length, 0)} training phrases`);

function logMiss(transcript, score, intent) {
  try {
    fs.mkdirSync(path.dirname(MISSES_LOG), { recursive: true });
    const line = `${new Date().toISOString()}\tscore=${score.toFixed(3)}\tclassified=${intent}\t${transcript.replace(/\s+/g, ' ')}\n`;
    fs.appendFileSync(MISSES_LOG, line);
  } catch { /* ignore */ }
}

// ── Entity extractors (rule-based, intent-specific) ────────────────────────
function cleanPatientQueryTail(s) {
  return String(s || '')
    .trim()
    .replace(/\s+(record|records|details|profile|info|file|chart|charts|history|case|please)\s*$/g, '')
    .trim();
}

function extractPatientQuery(text) {
  let t = String(text).replace(/[.?!,]+$/g, '').trim();
  const tLower = t.toLowerCase();

  const uhid = tLower.match(/\buhid\s+(\S+)/);
  if (uhid) return uhid[1];

  const phone = tLower.match(/\b(\d{5,})\b/);
  if (phone && !/\bpatient\s+\d/.test(tLower)) return phone[1];

  const forPatient = tLower.match(/\b(?:patient\s+)?records?\s+for\s+(?:patient\s+)?(.+)$/);
  if (forPatient) return cleanPatientQueryTail(forPatient[1]);

  const recordFor = tLower.match(/\b(?:patient\s+)?record\s+for\s+(?:patient\s+)?(.+)$/);
  if (recordFor) return cleanPatientQueryTail(recordFor[1]);

  const byPatient = tLower.match(/\bpatient\s+(?:named|called)?\s*(.+)$/);
  if (byPatient) return cleanPatientQueryTail(byPatient[1]);

  const byOf = tLower.match(
    /\b(?:records?|charts?|files?|profiles?|histories|cases?|opg|cbct|iopa|radiographs?|xray|xrays|notes?|demographics|odontogram|consent|allergies|medications?)\s+of\s+(?:the\s+)?(?:patient\s+)?(.+)$/
  );
  if (byOf) return cleanPatientQueryTail(byOf[1]);

  const who = tLower.match(/^who\s+is\s+(?!my\s+next\s)(.+)$/);
  if (who) return cleanPatientQueryTail(who[1]);

  const prefixes = [
    'show me the records of patient ', 'show me records of patient ',
    'show me the record of patient ', 'show me record of patient ',
    'show me the records of ', 'show me records of ',
    'show me the record of ', 'show me record of ',
    'show me patient records for ', 'show me patient record for ',
    'show me patient records of ', 'show me patient record of ',
    'show me the patient ', 'show me patient ', 'show me ',
    'open patient record of ', 'show patient record of ', 'show record of ',
    'open record of ', 'find patient record of ', 'get patient records for ',
    'open patient ', 'show patient ', 'find patient ', 'search patient ',
    'lookup patient ', 'look up patient ', 'look up the patient ',
    'patient record for ', 'patient records for ', 'patient lookup ',
    'pull up patient ', 'pull up the patient ', 'pull up ',
    'pull ', 'bring up ', 'bring up the patient ',
    'open ', 'show ', 'find ', 'search for ', 'search ', 'get me ', 'fetch ',
    'i want to see ', 'review ', 'display ',
  ];
  let work = tLower;
  for (const p of prefixes) {
    if (work.startsWith(p)) {
      work = work.slice(p.length);
      break;
    }
  }
  return cleanPatientQueryTail(work);
}

const BILLING_STRONG_RX = /\b(due|owed|owe|outstanding|balance\s+due|amount\s+due|final\s+amount|total\s+(bill|charge|amount)|how\s+much|payment\s+due|pending\s+(payment|bill)|balance\s+outstanding)\b/i;

function extractBillingAspect(text) {
  const t = String(text).toLowerCase();
  if (/\b(final\s+amount|total\s+(bill|charge|amount)|total\s+billed|full\s+bill)\b/.test(t)) {
    return 'total';
  }
  return 'due';
}

function extractBillingPatientQuery(text) {
  let work = String(text).replace(/[.?!,]+$/g, '').trim().toLowerCase();
  work = work
    .replace(/\b(how much does|how much is|how much do|what does|what do|what is|whats|what's|tell me|show me|get me|check|show)\b/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const forTail = work.match(
    /\b(?:due amount|balance due|outstanding(?:\s+balance|\s+amount|\s+bill)?|amount due|final amount|final bill|total bill|total charges?|payment due|billing balance|patient bill|bill balance|pending payment)\s+for\s+(?:patient\s+)?(.+)$/
  );
  if (forTail) return cleanPatientQueryTail(forTail[1]);

  const patientBalDue = work.match(/\bpatient\s+(.+?)\s+balance\s+due\s*$/);
  if (patientBalDue) return cleanPatientQueryTail(patientBalDue[1]);

  const patientDue = work.match(
    /\bpatient\s+(.+?)\s+(?:due|balance|bill|billing|outstanding|final amount|total bill)\s*$/
  );
  if (patientDue) return cleanPatientQueryTail(patientDue[1]);

  const owes = work.match(/\b(?:patient\s+)?(.+?)\s+(?:owe|owes|owed)\b/);
  if (owes) return cleanPatientQueryTail(owes[1]);

  const howMuch = work.match(/\bhow much does\s+(?:patient\s+)?(.+?)\s+(?:owe|due)\b/);
  if (howMuch) return cleanPatientQueryTail(howMuch[1]);

  work = work
    .replace(/\b(due amount|balance due|outstanding balance|outstanding amount|amount due|final amount|final bill|total bill|total charges?|payment due|billing balance|patient bill|bill balance|pending payment|outstanding bill)\b/g, ' ')
    .replace(/\b(billing|invoice|payment|accounts?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const q = extractPatientQuery(work || text);
  if (q && q.length >= 2) return q;

  const named = work.match(/\b(?:for\s+)?(?:patient\s+)?([a-z][a-z\s]{1,40})$/);
  if (named) return cleanPatientQueryTail(named[1]);
  return null;
}

function tryAppExitRule(raw) {
  if (!isAppExitUtterance(raw)) return null;
  const reason = appExitReason(raw);
  const tone   = appExitTone(raw);
  return {
    intent:   'app.exit',
    score:    0.94,
    entities: { tone, reason },
  };
}

function tryAccountSignOutRule(raw) {
  if (!isAccountSignOutUtterance(raw)) return null;
  return {
    intent:   'account.sign_out',
    score:    0.93,
    entities: { tone: 'direct' },
  };
}

function tryBillingRule(raw) {
  const t = String(raw).toLowerCase();
  if (/\b(open|go to|show|take me to|switch to)\s+(the\s+)?(billing|accounts?)(\s+page|\s+module|\s+screen)?\b/.test(t)
      && !BILLING_STRONG_RX.test(t)) {
    return null;
  }
  if (/\b(open|show|find|search|lookup|pull up)\s+patient\b/.test(t) && !BILLING_STRONG_RX.test(t)) {
    return null;
  }
  const hasStrong = BILLING_STRONG_RX.test(t);
  const hasBillingFor = /\b(billing|invoice|payment)\s+(for|of)\s+(?:patient\s+)?\w/.test(t);
  if (!hasStrong && !hasBillingFor) return null;

  const aspect = extractBillingAspect(raw);
  if (/\b(this patient|current patient|the patient on screen)\b/i.test(raw)) {
    return { intent: 'billing.patient', score: 0.9, entities: { query: null, aspect } };
  }
  const q = extractBillingPatientQuery(raw);
  if (!q || q.length < 2) return null;
  return { intent: 'billing.patient', score: 0.92, entities: { query: q, aspect } };
}

const NAV_TARGETS = [
  { rx: /\b(today.?s )?(schedule|appointment board|kanban|dashboard|board)\b/, target: 'schedule' },
  { rx: /\b(book(ing)?( a)?( new)? appointment|new appointment|booking|book now)\b/, target: 'booking' },
  { rx: /\b(patients?( list)?|patient search|patient directory)\b/, target: 'patients' },
  { rx: /\b(inventory|stock|consumables)\b/, target: 'inventory' },
  { rx: /\b(labs?|lab orders?|lab work)\b/, target: 'labs' },
  { rx: /\b(treatment plans?)\b/, target: 'treatment-plans' },
  { rx: /\b(prescriptions?|prescription pad|rx|medications?)\b/, target: 'rx' },
  // Specific specialties first — each has its own case-list page.
  { rx: /\b(ortho|orthodontics?|braces)( cases| module)?\b/, target: 'specialty-orthodontic' },
  { rx: /\b(implants?|implantology)( cases| module)?\b/, target: 'specialty-implantology' },
  { rx: /\b(endo|endodontics?)( cases| module)?\b/, target: 'specialty-endodontic' },
  { rx: /\b(paedo|paediatrics?|pediatrics?|pedo)( cases| module)?\b/, target: 'specialty-paediatric' },
  { rx: /\btmj( cases| module)?\b/, target: 'specialty-tmj' },
  { rx: /\bspecialty( cases| modules?)?\b/, target: 'specialty' },
  { rx: /\b(billing|payments?|invoices?)\b/, target: 'billing' },
  { rx: /\baccounts?\b/, target: 'accounts' },
  { rx: /\b(hr|human resources?|staff)\b/, target: 'hr' },
  { rx: /\b(release notes?|changelog)\b/, target: 'release-notes' },
  { rx: /\b(feature flags?|features?)\b/, target: 'feature-flags' },
  { rx: /\b(settings?|preferences)\b/, target: 'settings' },
];
function extractNavTarget(text) {
  const t = String(text).toLowerCase();
  for (const m of NAV_TARGETS) if (m.rx.test(t)) return m.target;
  return null;
}

/**
 * Parse a clock time out of an utterance. Tolerates the dotted meridiem forms
 * speech recognition produces ("4 p.m.", "8 a.m") — the old inline regex only
 * matched bare "pm", silently dropped the meridiem, and booked 8 pm as 08:00.
 * Word hours ("eight pm") are converted before matching. A bare number only
 * counts as a time when anchored by "at" / a colon / a meridiem, so "book 2
 * fillings" doesn't produce a phantom 02:00.
 */
function parseClockTime(text) {
  let s = String(text).toLowerCase()
    .replace(/([ap])\.?\s?m\b\.?/g, '$1m')     // p.m. / p. m / a.m → pm / am
    .replace(/\bo'?\s?clock\b/g, '');
  const hourWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  for (const [w, n] of Object.entries(hourWords)) s = s.replace(new RegExp(`\\b${w}\\b`, 'g'), String(n));
  s = s.replace(/\bthirty\b/g, '30').replace(/\bforty\s?5\b/g, '45').replace(/\b15\b(?=\s*(am|pm|$))/g, '15').replace(/\bquarter past\b/g, ':15').replace(/\bhalf past\b/g, ':30');

  const m = s.match(/\b(\d{1,2})(?:[:\s](\d{2}))?\s*(am|pm)\b/)   // meridiem present
        || s.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/)             // "at 4", "at 4:30"
        || s.match(/\b(\d{1,2}):(\d{2})\b/);                      // "16:30"
  if (!m) return null;
  let hh = +m[1]; const mm = m[2] ? +m[2] : 0; const mer = m[3];
  if (isNaN(hh) || hh > 23 || mm > 59) return null;
  if (mer === 'pm' && hh < 12) hh += 12;
  if (mer === 'am' && hh === 12) hh = 0;
  // Clinic heuristic: an unqualified "at 1"–"at 7" almost always means afternoon/evening.
  if (!mer && hh >= 1 && hh <= 7) hh += 12;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function extractBookingEntities(text) {
  const t = String(text).toLowerCase();
  const out = { service: null, patient: null, time: null, date: null };

  const sched = t.match(/^schedul(?:e|ing)\s+(.+)$/);
  const book  = t.match(/^book(?:ing)?(?:\s+a|\s+an)?\s+(.+)$/);
  const body  = (book || sched)?.[1] || null;
  if (body) {
    const forSplit = body.split(/\s+for\s+/);
    out.service = forSplit[0].replace(/\s+(at|on|tomorrow|today|next).*$/, '').trim() || null;
    if (forSplit[1]) out.patient = forSplit[1].replace(/\s+(at|on|tomorrow|today).*$/, '').trim();
  }

  const clock = parseClockTime(t);
  if (clock) {
    out.time = clock;
  } else {
    const period = t.match(/\b(noon|midday|morning|afternoon|evening)\b/);
    if (period) out.period = period[1];
  }
  // Possessive forms ("tomorrow's", "monday's") and Hindi kal/aaj included.
  if (/\btomorrow(?:'?s)?\b|\bkal\b/.test(t)) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    out.date = d.toISOString().slice(0, 10);
  } else if (/\btoday(?:'?s)?\b|\baaj\b/.test(t)) {
    out.date = new Date().toISOString().slice(0, 10);
  } else {
    const wd = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:'?s)?\b/);
    if (wd) out.weekday = wd[1];
  }
  return out;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Next occurrence of a weekday name (today counts as a match). */
function weekdayToDate(weekday) {
  const idx = WEEKDAYS.indexOf(String(weekday || '').toLowerCase());
  if (idx < 0) return null;
  const d = new Date();
  d.setDate(d.getDate() + ((idx - d.getDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

/** Spoken label for a date: "today" / "tomorrow" / "on Friday". */
function dayLabel(dateIso) {
  if (!dateIso) return 'today';
  const now = new Date();
  const today    = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  if (dateIso === today) return 'today';
  if (dateIso === tomorrow) return 'tomorrow';
  try { return 'on ' + WEEKDAYS[new Date(`${dateIso}T00:00:00`).getDay()][0].toUpperCase() + WEEKDAYS[new Date(`${dateIso}T00:00:00`).getDay()].slice(1); }
  catch { return `on ${dateIso}`; }
}

function extractScheduleTimeEntities(text) {
  const t = String(text).toLowerCase();
  const out = { time: null, period: null, date: null, weekday: null, chair: null };

  const chair = t.match(/\bchair\s*(\d+)\b/);
  if (chair) out.chair = chair[1];

  const clock = parseClockTime(t);
  if (clock) {
    out.time = clock;
  } else {
    const period = t.match(/\b(morning|afternoon|evening|noon|midday)\b/);
    if (period) out.period = period[1];
  }

  // Possessive forms ("tomorrow's", "monday's") and Hindi kal/aaj included.
  if (/\btomorrow(?:'?s)?\b|\bkal\b/.test(t)) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    out.date = d.toISOString().slice(0, 10);
  } else if (/\btoday(?:'?s)?\b|\baaj\b/.test(t)) {
    out.date = new Date().toISOString().slice(0, 10);
  } else {
    const wd = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:'?s)?\b/);
    if (wd) out.weekday = wd[1];
  }
  return out;
}

const BEHAVIOUR_ACTIONS = [
  { rx: /\b(speak|talk)\s+louder\b|\braise\s+(your\s+)?voice\b/, action: 'speak_louder' },
  { rx: /\b(speak|talk)\s+(softer|quieter|lower)\b|\blower\s+your\s+voice\b/, action: 'speak_softer' },
  { rx: /\b(speak|talk)\s+slower\b|\bslow\s+down\b/, action: 'speak_slower' },
  { rx: /\b(speak|talk)\s+faster\b|\bspeed\s+up\b/, action: 'speak_faster' },
  { rx: /\b(be\s+)?brief\b|\b(concise|keep\s+it\s+short)\b/, action: 'be_brief' },
  { rx: /\bmore\s+detail\b|\bbe\s+detailed\b|\bexplain\s+more\b/, action: 'be_detailed' },
  { rx: /\bconfirm\s+before\b|\bask\s+before\b|\bdont\s+act\s+without\b/, action: 'confirm_before_act' },
  { rx: /\b(auto\s+mode|without\s+asking|just\s+do\s+it)\b/, action: 'auto_mode' },
  { rx: /\brepeat\s+(that|last|slower|louder)\b|\bsay\s+that\s+again\b/, action: 'repeat' },
  { rx: /\b(mute\s+yourself|be\s+quiet|stop\s+talking)\b/, action: 'mute' },
  { rx: /\bunmute\b/, action: 'unmute' },
  { rx: /\bstop\s+listening\b|\bpause\s+listening\b/, action: 'pause_listening' },
  { rx: /\b(start|resume)\s+listening\b/, action: 'resume_listening' },
  { rx: /\bstop\s+interrupting\b|\bdont\s+cut\s+me\s+off\b|\bwait\s+for\s+me\b/, action: 'no_interrupt' },
  { rx: /\b(speak|talk)\s+hindi\b|\bswitch\s+to\s+hindi\b|\buse\s+hinglish\b|\bhindi\s+(bolo?|me[in]?\s+bolo?)\b/, action: 'language_hindi' },
  { rx: /\b(speak|talk)\s+english\b|\bswitch\s+to\s+english\b|\benglish\s+(bolo?|me[in]?\s+bolo?)\b/, action: 'language_english' },
  { rx: /\b(speak|talk)\s+marathi\b|\bswitch\s+to\s+marathi\b|\bmarathi\s+(bol|bola|madhe)\b/, action: 'language_marathi' },
  { rx: /\bmore\s+sarcastic\b|\bmore\s+humou?r\b/, action: 'more_sarcasm' },
  { rx: /\b(less\s+sarcastic|less\s+jokes|no\s+small\s+talk)\b/, action: 'less_sarcasm' },
  { rx: /\b(reset|default)\s+(personality|behavio(u)?r|mode)\b|\bnormal\s+mode\b/, action: 'reset' },
  { rx: /\b(use\s+)?medical\s+terms\b/, action: 'medical_terms' },
  { rx: /\b(simple\s+words|plain\s+language)\b/, action: 'simple_language' },
  { rx: /\bfocus\s+mode\b/, action: 'focus_mode' },
  { rx: /\bworkaholic\b|\bwork\s*aholic\b|\ball\s*work\s+no\s+rest\b|\bnever\s+leave\s+the\s+clinic\b/, action: 'workaholic_mode' },
];
function extractBehaviourAction(text) {
  const t = String(text).toLowerCase();
  for (const m of BEHAVIOUR_ACTIONS) if (m.rx.test(t)) return m.action;
  return 'adjust';
}

function extractAgentProactiveTopic(text) {
  const t = String(text).toLowerCase().replace(/^friday\s+/, '');
  const m = t.match(/(?:remind|notify|alert|watch|monitor|update)\s+(?:me\s+)?(?:when|on|for)?\s*(.+)$/);
  if (m) return m[1].replace(/\s+please\s*$/g, '').trim();
  if (/what should i do|next task|prioriti/.test(t)) return 'next_task';
  if (/proactive|smart reminder|auto update|proactive mode/.test(t)) return 'proactive_mode';
  if (/attention|urgent|anything urgent/.test(t)) return 'urgent_items';
  if (/prep me for next|next case|next patient details/.test(t)) return 'next_patient_prep';
  return t.slice(0, 80);
}

// ── Public API ─────────────────────────────────────────────────────────────
const CONFIDENCE_FLOOR = typeof TRAINING_META.confidence_floor === 'number'
  ? TRAINING_META.confidence_floor
  : 0.18;

// Out-of-domain guard — instead of a flat "I didn't understand", Friday now
// deflects with personality and steers back to work. Each category has its
// own reply bank so the response actually acknowledges what was asked.
const OOD_CATEGORIES = [
  {
    key: 'food',
    rx: /\b(pizza|burger|biryani|swiggy|zomato|dominos|coffee|chai|tea|lunch|dinner|snacks?|hungry)\b|\border\s+(a\s+)?(pizza|food|meal)\b/,
    replies: [
      "Tempting — but I only order crowns and composites, {addressee}. Your stomach is on its own.",
      "I can't get you food, but I can clear your schedule fast enough to grab some. Want today's summary?",
      "Swiggy is out of my scope of practice. Patients, bookings, billing — that's my menu.",
    ],
  },
  {
    key: 'entertainment',
    rx: /\b(netflix|spotify|youtube|music|playlist|song|movie|film|series|cricket|match|score|ipl|game)\b|\bplay\s+(some\s+)?music\b/,
    replies: [
      "My only playlist is the sound of a fully booked schedule, {addressee}. Try the clinic speakers.",
      "I don't stream anything except appointment data. Now — anything clinical?",
      "If it's not on the appointment board, I can't play it. Schedule instead?",
    ],
  },
  {
    key: 'transport',
    rx: /\b(uber|ola|cab|taxi|ride|auto\s*rickshaw|train\s+ticket|flight|book\s+a\s+(cab|flight|train))\b/,
    replies: [
      "I book chairs, not cabs, {addressee}. Chair 1 is available though.",
      "The only rides I arrange end in a dental chair. Need a booking?",
    ],
  },
  {
    key: 'general',
    rx: /\b(news|stock\s+market|share\s+price|weather\s+in|horoscope|lottery|matka)\b/,
    replies: [
      "That's outside my scope of practice — I'm licensed for dentistry, not fortune telling.",
      "I only forecast schedules, {addressee}. Today's looks busy — want the summary?",
    ],
  },
];

function outOfDomainCategory(text) {
  const t = String(text).toLowerCase();
  for (const cat of OOD_CATEGORIES) if (cat.rx.test(t)) return cat;
  return null;
}
function isOutOfDomain(text) { return outOfDomainCategory(text) !== null; }

// ── Summon rule — bare wake word ("friday", "hey friday", "you there?") ─────
const SUMMON_RX = /^(?:hey\s+|oi\s+|yo\s+|ok\s+|okay\s+)?friday[\s?!.]*$|^(?:friday\s+)?(?:are\s+)?you\s+there[\s?!.]*$|^you\s+up\s+friday[\s?!.]*$/i;
function trySummonRule(raw) {
  if (!SUMMON_RX.test(String(raw).trim())) return null;
  return { intent: 'smalltalk.summon', score: 0.95, entities: {} };
}

// ── Joke rule — an actual joke bank, not a sarcastic dodge ──────────────────
const JOKE_RX = /\b(tell\s+me\s+a\s+joke|another\s+joke|one\s+more\s+joke|make\s+me\s+laugh|crack\s+a\s+joke|joke\s+please|say\s+a\s+joke|got\s+any\s+jokes?|know\s+any\s+jokes?)\b/i;
function tryJokeRule(raw) {
  if (!JOKE_RX.test(String(raw))) return null;
  return { intent: 'smalltalk.joke', score: 0.95, entities: {} };
}

// ── "who is <name>" — a person question is a patient lookup unless the name
// is Friday itself (that's an identity question). Without this rule the
// identity corpus ("who is friday") pulls single-name queries its way.
function tryWhoIsRule(raw) {
  const m = String(raw).trim().replace(/[?.!]+$/, '').match(/^who\s+is\s+(.+)$/i);
  if (!m) return null;
  const name = m[1].trim().toLowerCase();
  if (/^(friday|you|it|she|he|this|that|there)$/.test(name)) return null; // identity/pronoun — let model decide
  if (/^my\s+next\b/.test(name)) return null;                            // "who is my next patient" → schedule
  // "who is at 3pm / in chair 1 / next / coming tomorrow" — schedule, not a person.
  if (/^(at|in|on|next|coming|scheduled|waiting|first|last|free)\b/.test(name)) return null;
  if (/\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b(morning|afternoon|evening|noon|today|tomorrow|chair)\b/.test(name)) return null;
  return { intent: 'patient.find', score: 0.9, entities: {} };
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const REPLIES = {
  unknown: [
    "Hmm — that one's not in my playbook yet, {addressee}. I've logged it so I can learn. Meanwhile: patients, bookings, billing, schedule — I speak those fluently.",
    "You've officially stumped me. Try a patient name, a page, or ask what's on today.",
    "I heard you, but couldn't map that to anything useful. Want me to open a patient, check the schedule, or start a booking?",
    "Not sure what to do with that one, {addressee}. I'm brilliant, but specialised — say something like \"open patient Ravi\" or \"who's at 3pm\".",
    "That went over my circuits. Give me a patient, a time, or a place in the app and I'm unstoppable.",
  ],
  empty:             "I didn't catch that.",
  patient_no_name:   "I didn't catch the patient name.",
  billing_no_patient: 'Which patient should I check billing for?',
  clarify: [
    "I didn't quite catch that — did you mean “{suggestion}”?",
    "Not 100% sure, {addressee} — should I {suggestion}?",
    "Sounded like you want me to {suggestion} — yes or no?",
  ],
  clarify_dropped: [
    "Okay, scratched that. What do you need, {addressee}?",
    "No problem — dropped it. What's next?",
    "Fair enough. I'm listening.",
  ],
  affirm_nothing: [
    "Yes to… what exactly, {addressee}? Give me the command again.",
    "I'll take the enthusiasm, but I've got nothing pending. What do you need?",
  ],
  summon: [
    "Yes, {addressee}?",
    "Right here. Go ahead.",
    "Listening, {addressee}.",
    "At your service — what do you need?",
    "You rang? I'm all ears. Well, all microphone.",
  ],
  jokes: [
    "What does the dentist of the year get? A little plaque.",
    "Why did the smartphone go to the dentist? It had Bluetooth problems.",
    "A patient asked if the extraction would hurt. I said no — the bill does that part.",
    "What's a dentist's favourite time? Tooth-hurty, {addressee}. I'll see myself out.",
    "I told a patient to floss daily. He said he does — every day he eats at a restaurant with toothpicks.",
    "Why do dentists make great detectives? They always get to the root of the problem.",
    "What did the tooth say to the departing dentist? Fill me in when you get back.",
    "Dentists hate one thing about vacations: they lose their filling of purpose.",
    "Why was the toothbrush sad? It got brushed off. Unlike your 3pm patient — they actually showed up.",
  ],
  greeting: [
    "Yes {addressee}, what do you want me to do?",
    "At your service, {addressee} — what's next?",
    "Yes {addressee}, I'm listening.",
    "Ready {addressee}, just say the word.",
  ],
  thanks: [
    "You're welcome, {addressee} — what's next?",
    "Anytime. Another one?",
    "Happy to help. Need anything else, {addressee}?",
    "My pleasure, {addressee}.",
  ],
  bye: [
    "Goodbye, {addressee} — I'll be right here when you need me.",
    "Catch you later, {addressee}.",
    "Take care, {addressee}. Try not to miss me too much.",
    "Logging today as 'survived'. See you, {addressee}.",
  ],
  sarcasm: [
    "I'd love to help, {addressee}, but witty comebacks aren't billable yet.",
    "Funny. Now — anything I can actually do for you?",
    "I'm allergic to small talk. Try \"open patient\" instead.",
    "Bold of you to roast the only one here who never forgets a chart number.",
    "I'd take offense, but my ego is stored in read-only memory.",
    "Cute. Should I file that under 'feedback' or 'noise', {addressee}?",
    "I can diagnose sarcasm — treating it is above my pay grade. Got a real command?",
    "Ha. Now ask me something with a patient name in it, {addressee}.",
    "That's adorable. Shall we get back to actual dentistry?",
  ],
  proactive: [
    "Got it — I'll keep an eye on that and nudge you when something changes.",
    "Understood, {addressee}. I'll watch for that and update you.",
    "Sure {addressee}, I'll stay on top of that. Anything else I should watch?",
  ],
  identity: [
    "I'm Friday — your clinic's voice in the machine. Less Iron Man, more root canals. What do you need, {addressee}?",
    "Friday: part receptionist, part chart-wrangler, zero coffee breaks. Where shall we start, {addressee}?",
    "I'm Friday, {addressee} — I run your schedule, find patients, and judge your handwriting in silence. What's first?",
  ],
  help: [
    "I can open patients, book appointments, check dues, read your schedule, and navigate the app. Try \"open patient Ravi\" or \"how many patients today\". What'll it be, {addressee}?",
    "Commands I actually enjoy: \"book a cleaning for Asha\", \"due amount for Paras\", \"go to inventory\". Want to try one, {addressee}?",
    "Patients, bookings, billing, navigation, schedule — say it like you mean it. What do you want first, {addressee}?",
  ],
  howareyou: [
    "Running at 100%, no caffeine required — more than I can say for the waiting room. How are YOU holding up, {addressee}?",
    "Flawless, as always. Ask me something hard, {addressee}, I'm bored.",
    "I'm a voice assistant, {addressee} — no feelings, just uptime, and mine's perfect. What do you need?",
  ],
  compliment: [
    "Flattery noted and filed under 'obviously'. What's next, {addressee}?",
    "I'd blush if I had cheeks. Back to work, {addressee}?",
    "Careful {addressee}, I'll start charging for compliments. What can I pull up?",
  ],
  behaviour: {
    speak_louder:       "I'll speak up.",
    speak_softer:       'Got it — softer voice.',
    speak_slower:       'Slowing down.',
    speak_faster:       'Picking up the pace.',
    be_brief:           'Short answers from here on.',
    be_detailed:        "I'll give you more detail.",
    confirm_before_act: "I'll confirm before I act.",
    auto_mode:          "Auto mode — I'll act without asking.",
    repeat:             'Repeating that now.',
    mute:               'Going quiet.',
    unmute:             "I'm back — voice on.",
    pause_listening:    'Paused listening.',
    resume_listening:   'Listening again.',
    no_interrupt:       "I'll wait until you finish.",
    language_hindi:     'Hindi mode noted — thoda hinglish chalega?',
    language_english:   'English mode.',
    language_marathi:   'Marathi noted — मी प्रयत्न करेन. My Marathi is still in braces, but I understand you.',
    more_sarcasm:       'Oh wonderful — more personality. Noted.',
    less_sarcasm:       'All business from here.',
    reset:              'Back to default settings.',
    medical_terms:      'Clinical terminology mode.',
    simple_language:    'Plain language mode.',
    focus_mode:         'Focus mode on.',
    workaholic_mode:    null,
    adjust:             'Behaviour updated.',
  },
};

function attachTimeContext(result, raw) {
  const ctx = getTimeContext();
  const out = {
    ...result,
    time_context: ctx,
  };
  if (result.intent === 'smalltalk.greeting') {
    out.entities = {
      ...result.entities,
      period:      ctx.period,
      said_period: detectSaidPeriod(raw),
    };
  }
  if (result.intent === 'behaviour' && result.entities?.action === 'workaholic_mode') {
    out.entities = { ...result.entities, period: ctx.period };
  }
  if (result.intent === 'smalltalk.time') {
    out.entities = { ...result.entities, period: ctx.period, time: ctx.time_label };
  }
  return out;
}

function buildIntentResult(raw, best) {
  const base = {
    intent:     best.intent,
    confidence: best.score,
    entities:   { ...(best.entities || {}) },
  };

  switch (best.intent) {
    case 'billing.patient': {
      const aspect = base.entities.aspect || extractBillingAspect(raw);
      const q      = base.entities.query !== undefined
        ? base.entities.query
        : extractBillingPatientQuery(raw);
      if (q === null && !/\b(this|current)\s+patient\b/i.test(raw)) {
        return {
          ...base,
          entities: { aspect },
          message:  REPLIES.billing_no_patient,
        };
      }
      const entities = { aspect };
      if (q) entities.query = q;
      const label = q || 'this patient';
      return {
        ...base,
        entities,
        message: `Checking billing for ${label}…`,
      };
    }
    case 'patient.find': {
      const q = extractPatientQuery(raw);
      if (!q || q.length < 2) {
        return { ...base, intent: 'unknown', entities: {}, message: REPLIES.patient_no_name };
      }
      return { ...base, entities: { query: q }, message: `Searching for ${q}…` };
    }
    case 'navigate': {
      // If the raw text doesn't parse (ASR typo like "shedule"), retry against
      // a vocabulary-corrected copy before giving up.
      const target = extractNavTarget(raw) || extractNavTarget(fuzzyCorrect(raw, MODEL.idf));
      if (!target) {
        return { ...base, intent: 'unknown', entities: {}, message: "I'm not sure where to take you." };
      }
      return { ...base, entities: { target }, message: `Opening ${target}.` };
    }
    case 'appointment.book': {
      const e = extractBookingEntities(raw);
      return { ...base, entities: e, message: 'Starting a new booking.' };
    }
    case 'schedule.summary': {
      // "what's on tomorrow" / "friday's schedule" — carry the date so the
      // frontend fetches the right day instead of always today.
      const e    = extractScheduleTimeEntities(raw);
      const date = e.date || weekdayToDate(e.weekday);
      const label = dayLabel(date);
      return {
        ...base,
        entities: { ...base.entities, date: date || null, day_label: label },
        message:  `Here's the summary for ${label}.`,
      };
    }
    case 'schedule.time': {
      // Context follow-ups ("what about tomorrow?") arrive with pre-merged
      // entities — don't clobber them by re-extracting from the fragment.
      const e = (base.entities.time || base.entities.period || base.entities.date || base.entities.weekday)
        ? base.entities
        : extractScheduleTimeEntities(raw);
      if (!e.date && e.weekday) e.date = weekdayToDate(e.weekday);
      e.day_label = dayLabel(e.date);
      const when = [e.time || e.period, e.day_label].filter(Boolean).join(' ') || 'that time';
      return { ...base, entities: e, message: `Checking the schedule for ${when}.` };
    }
    case 'agent.proactive': {
      const topic = extractAgentProactiveTopic(raw);
      return { ...base, entities: { topic }, message: pick(REPLIES.proactive) };
    }
    case 'behaviour': {
      const action = extractBehaviourAction(raw);
      let message = REPLIES.behaviour[action];
      if (action === 'workaholic_mode') message = workaholicMessage(getTimeContext(), {});
      if (!message) message = REPLIES.behaviour.adjust;
      return { ...base, entities: { action }, message };
    }
    case 'app.exit': {
      const tone   = base.entities.tone || appExitTone(raw);
      const reason = base.entities.reason || appExitReason(raw);
      return {
        ...base,
        entities: { tone, reason },
        message:  appExitMessage(tone, reason),
        action:   buildLogoutAction(tone, reason),
      };
    }
    case 'account.sign_out':
      return {
        ...base,
        entities: { tone: 'direct', reason: 'sign_out' },
        message:  appExitMessage('direct', 'sign_out'),
        action:   buildLogoutAction('direct', 'sign_out'),
      };
    case 'smalltalk.greeting':
      return { ...base, message: greetingMessage(raw) };
    case 'smalltalk.thanks':
      return { ...base, message: pick(getTimeContext().night ? NIGHT_REPLIES.thanks : REPLIES.thanks) };
    case 'smalltalk.bye':
      return { ...base, message: pick(getTimeContext().night ? NIGHT_REPLIES.bye : REPLIES.bye) };
    case 'smalltalk.time':
      return { ...base, message: nowMessage() };
    case 'smalltalk.weather':
      return { ...base, message: "I can't see the sky from in here — but I can tell you who's next in the chair." };
    case 'smalltalk.sarcasm':
      return { ...base, message: pick(REPLIES.sarcasm) };
    case 'smalltalk.identity':
      return { ...base, message: pick(REPLIES.identity) };
    case 'smalltalk.help':
      return { ...base, message: pick(REPLIES.help) };
    case 'smalltalk.howareyou':
      return { ...base, message: pick(getTimeContext().night ? NIGHT_REPLIES.howareyou : REPLIES.howareyou) };
    case 'smalltalk.compliment':
      return { ...base, message: pick(REPLIES.compliment) };
    case 'smalltalk.summon':
      return { ...base, message: pick(REPLIES.summon) };
    case 'smalltalk.joke':
      return { ...base, message: pick(REPLIES.jokes) };
    default:
      return { ...base, intent: 'unknown', message: pick(REPLIES.unknown) };
  }
}

// Confidence band [CLARIFY_FLOOR, CONFIDENCE_FLOOR): instead of failing,
// Friday asks "did you mean …?" and executes on a yes.
const CLARIFY_FLOOR = 0.10;

/** Human verb-phrase for a candidate result, used in "did you mean …?". */
function clarifySuggestionLabel(result) {
  switch (result.intent) {
    case 'patient.find':     return result.entities?.query ? `open ${result.entities.query}'s record` : null;
    case 'navigate':         return result.entities?.target ? `open ${result.entities.target}` : null;
    case 'appointment.book': return 'start a new booking';
    case 'schedule.summary': return "read out today's summary";
    case 'schedule.time':    return 'check the schedule';
    case 'billing.patient':  return result.entities?.query ? `check billing for ${result.entities.query}` : null;
    default:                 return null; // don't clarify smalltalk — just answer or pass
  }
}

/** Persist whatever this turn taught us for the next one. */
function rememberTurn(userId, result) {
  if (!userId) return;
  const patch = { lastIntent: result.intent, lastEntities: result.entities || {} };
  const q = result.entities?.query;
  if ((result.intent === 'patient.find' || result.intent === 'billing.patient') && q) {
    patch.lastPatientQuery = q;
  }
  convo.remember(userId, patch);
}

function classify(transcript, userId = null) {
  const raw = String(transcript || '').trim();
  if (!raw) {
    return { intent: 'unknown', confidence: 0, entities: {}, message: REPLIES.empty };
  }

  const ctx = convo.recall(userId);

  // ── Pending confirmation ("did you mean …?" → yes / no) ──────────────────
  if (ctx?.pending) {
    if (convo.isAffirmation(raw)) {
      const pending = convo.takePending(userId);
      const result  = attachTimeContext(pending, raw);
      rememberTurn(userId, result);
      return result;
    }
    if (convo.isNegation(raw)) {
      convo.clearPending(userId);
      return {
        intent: 'smalltalk.ack', confidence: 1, entities: {},
        message: pick(REPLIES.clarify_dropped), time_context: getTimeContext(),
      };
    }
    // Anything else: drop the pending question and process the new utterance.
    convo.clearPending(userId);
  } else if (convo.isAffirmation(raw)) {
    // A bare "yes" with nothing pending.
    return {
      intent: 'smalltalk.ack', confidence: 1, entities: {},
      message: pick(REPLIES.affirm_nothing), time_context: getTimeContext(),
    };
  } else if (convo.isNegation(raw)) {
    // A bare "no"/"cancel" with nothing pending — acknowledge and move on
    // (otherwise "no" leaks into the model and matches "no shows" phrases).
    return {
      intent: 'smalltalk.ack', confidence: 1, entities: {},
      message: pick(REPLIES.clarify_dropped), time_context: getTimeContext(),
    };
  }

  // ── Out-of-domain: deflect with personality instead of a flat failure ─────
  const ood = outOfDomainCategory(raw);
  if (ood) {
    logMiss(raw, 0, `ood.${ood.key}`);
    return {
      intent: 'smalltalk.oob', confidence: 0.9, entities: { category: ood.key },
      message: pick(ood.replies), time_context: getTimeContext(),
    };
  }

  // ── High-precision rules (raw utterance) ──────────────────────────────────
  for (const rule of [trySummonRule, tryJokeRule, tryAppExitRule, tryAccountSignOutRule]) {
    const hit = rule(raw);
    if (hit) {
      const result = attachTimeContext(buildIntentResult(raw, hit), raw);
      rememberTurn(userId, result);
      return result;
    }
  }

  // ── Wake-word prefix + meridiem normalization ─────────────────────────────
  // Users prefix commands with the wake word ("friday open patient ravi") —
  // strip it so the command itself drives extraction. Also collapse the dotted
  // meridiem forms ASR produces ("3 p.m." → "3pm") so tokenization matches the
  // training corpus instead of shedding single-character fragments.
  let effective = raw
    .replace(/^(?:(?:hey|ok|okay|yo|oi)[,\s]+)?friday[,!\s]+(?=\S)/i, '')
    .replace(/([ap])\.?\s?m\b\.?/gi, '$1m')
    .replace(/(\d)\s+(am|pm)\b/gi, '$1$2');

  // ── Context carryover ─────────────────────────────────────────────────────
  // Pronouns → last patient: "what does she owe" → "what does asha owe".
  if (ctx?.lastPatientQuery && convo.referencesLastPatient(effective)) {
    effective = convo.resolvePronouns(effective, ctx);
  }

  // Schedule follow-ups: "what about tomorrow?", "and 4pm?" after a schedule
  // question — merge new time parts over the previous ones, no reclassification.
  const tail = convo.followUpTail(raw);
  if (tail && (ctx?.lastIntent === 'schedule.time' || ctx?.lastIntent === 'schedule.summary')) {
    const e = extractScheduleTimeEntities(tail);
    if (e.time || e.period || e.date || e.weekday) {
      const prev        = ctx.lastEntities || {};
      const dateChanged = !!(e.date || e.weekday);
      const timeChanged = !!(e.time || e.period);
      // "what about tomorrow" keeps the previous time; "and 4pm?" keeps the date.
      const merged = {
        time:    e.time    || (dateChanged && !timeChanged ? prev.time    : null),
        period:  e.period  || (dateChanged && !timeChanged ? prev.period  : null),
        date:    e.date    || (timeChanged && !dateChanged ? prev.date    : null),
        weekday: e.weekday || (timeChanged && !dateChanged ? prev.weekday : null),
        chair:   e.chair   || prev.chair || null,
      };
      const result = attachTimeContext(
        buildIntentResult(raw, { intent: 'schedule.time', score: 0.9, entities: merged }), raw
      );
      rememberTurn(userId, result);
      return result;
    }
  }

  const billingRule = tryBillingRule(effective);
  if (billingRule) {
    const result = attachTimeContext(buildIntentResult(effective, billingRule), effective);
    rememberTurn(userId, result);
    return result;
  }

  // "who is <name>" — after pronoun resolution so "who is she?" works too.
  const whoIsRule = tryWhoIsRule(effective);
  if (whoIsRule) {
    const result = attachTimeContext(buildIntentResult(effective, whoIsRule), effective);
    rememberTurn(userId, result);
    return result;
  }

  // ── Statistical model (fuzzy query vector tolerates ASR typos) ────────────
  const tokens = tokenize(effective);
  if (!tokens.length) {
    return { intent: 'unknown', confidence: 0, entities: {}, message: REPLIES.empty };
  }

  const vec = vectorizeQuery(tokens, MODEL.idf);
  let best = { intent: 'unknown', score: 0 };
  for (const intent of MODEL.intents) {
    const score = scoreIntent(vec, intent, MODEL);
    if (score > best.score) best = { intent, score };
  }

  if (best.score >= CONFIDENCE_FLOOR) {
    const result = attachTimeContext(buildIntentResult(effective, best), effective);
    rememberTurn(userId, result);
    return result;
  }

  // ── Borderline: ask instead of failing ────────────────────────────────────
  if (best.score >= CLARIFY_FLOOR && userId) {
    const candidate = buildIntentResult(effective, best);
    const label     = clarifySuggestionLabel(candidate);
    if (label && candidate.intent !== 'unknown') {
      convo.setPending(userId, candidate);
      logMiss(raw, best.score, `clarify.${candidate.intent}`);
      return {
        intent:     'clarify',
        confidence: best.score,
        entities:   { suggestion: candidate.intent },
        message:    pick(REPLIES.clarify).replace('{suggestion}', label),
        time_context: getTimeContext(),
      };
    }
  }

  logMiss(raw, best.score, best.intent);
  return {
    intent: 'unknown', confidence: best.score, entities: {},
    message: pick(REPLIES.unknown), time_context: getTimeContext(),
  };
}

module.exports = {
  classify,
  extractPatientQuery,
  extractBillingPatientQuery,
  extractBillingAspect,
  getTimeContext,
  TRAINING_DATA: ACTIVE_TRAINING,
};
