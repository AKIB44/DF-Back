// ────────────────────────────────────────────────────────────────────────────
// Friday conversation context — short-term per-user memory (in-process)
// ────────────────────────────────────────────────────────────────────────────
//
// Gives Friday multi-turn awareness without any external service:
//   - "open patient ravi"  →  "what does he owe?"        (pronoun carryover)
//   - "who's at 3pm?"      →  "what about tomorrow?"      (follow-up)
//   - low-confidence match →  "Did you mean …?" → "yes"   (pending confirmation)
//
// Memory is deliberately small and short-lived (a voice exchange, not a CRM):
// entries expire after TTL_MS and the map is capped to avoid unbounded growth.
// ────────────────────────────────────────────────────────────────────────────

const TTL_MS      = 4 * 60 * 1000; // one voice session ≈ a few minutes
const MAX_ENTRIES = 500;

const store = new Map(); // userId → { at, turns, lastPatientQuery, lastIntent, lastEntities, pending }

function now() { return Date.now(); }

function sweep() {
  if (store.size < MAX_ENTRIES) return;
  const cutoff = now() - TTL_MS;
  for (const [k, v] of store) {
    if (v.at < cutoff) store.delete(k);
  }
  // Still over cap → drop oldest.
  if (store.size >= MAX_ENTRIES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of oldest.slice(0, store.size - MAX_ENTRIES + 1)) store.delete(k);
  }
}

function recall(userId) {
  if (!userId) return null;
  const entry = store.get(userId);
  if (!entry) return null;
  if (now() - entry.at > TTL_MS) { store.delete(userId); return null; }
  return entry;
}

function remember(userId, patch) {
  if (!userId) return;
  sweep();
  const prev = recall(userId) || { turns: 0 };
  store.set(userId, { ...prev, ...patch, at: now(), turns: (prev.turns || 0) + 1 });
}

function setPending(userId, pending) {
  if (!userId) return;
  const prev = recall(userId) || { turns: 0 };
  store.set(userId, { ...prev, pending, at: now() });
}

function takePending(userId) {
  const entry = recall(userId);
  if (!entry?.pending) return null;
  const p = entry.pending;
  store.set(userId, { ...entry, pending: null, at: now() });
  return p;
}

function clearPending(userId) {
  const entry = recall(userId);
  if (entry) store.set(userId, { ...entry, pending: null, at: now() });
}

function clear(userId) {
  if (userId) store.delete(userId);
}

// ── Utterance shapes the context layer recognises ───────────────────────────

// Tolerant of natural padding: "yes please", "yeah go ahead friday",
// "no forget it", "nahi cancel karo".
const AFFIRM_WORD = '(?:yes|yeah|yep|yup|sure|ok(?:ay)?|correct|right|exactly|do it|go ahead|please do|haan|ha|thik hai|theek hai|done|confirm|absolutely|of course|why not)';
const AFFIRM_PAD  = '(?:please|friday|do it|go ahead|sure|ok(?:ay)?|thanks|yes|yeah|karo|kar do)';
const AFFIRM_RX   = new RegExp(`^${AFFIRM_WORD}(?:[\\s,]+${AFFIRM_PAD})*[.!?]*$`, 'i');

const NEGATE_WORD = "(?:no|nope|nah|nahi|cancel(?: that)?|never ?mind|forget it|leave it|dont|don't|not that|wrong|scratch that|stop)";
const NEGATE_PAD  = "(?:no|forget it|cancel|leave it|that|it|thanks|friday|please|nahi|karo|rehne do)";
const NEGATE_RX   = new RegExp(`^${NEGATE_WORD}(?:[\\s,]+${NEGATE_PAD})*[.!?]*$`, 'i');

function isAffirmation(text) { return AFFIRM_RX.test(String(text || '').trim()); }
function isNegation(text)    { return NEGATE_RX.test(String(text || '').trim()); }

// Pronoun / same-referent phrases that point back to the last patient.
const PRONOUN_RX = /\b(her|his|him|she|he|they|them|their|that patient|the same patient|same patient|this one|that one)\b/i;

/** True if the utterance leans on a previously mentioned patient. */
function referencesLastPatient(text) {
  return PRONOUN_RX.test(String(text || ''));
}

/**
 * Rewrite pronoun references to the remembered patient so the normal
 * extractors see a concrete name: "what does she owe" → "what does asha owe".
 */
function resolvePronouns(text, ctx) {
  const name = ctx?.lastPatientQuery;
  if (!name) return text;
  return String(text)
    .replace(/\b(that patient|the same patient|same patient|this one|that one)\b/gi, name)
    .replace(/\b(her|his|their)\b/gi, `${name}'s`)
    .replace(/\b(she|he|they|him|them)\b/gi, name);
}

// Follow-up fragments after a schedule question: "what about tomorrow",
// "and friday?", "same time tomorrow", "how about 4pm".
const FOLLOWUP_RX = /^(what about|how about|and|what if|same (thing|time)( for)?|also check)\s+(.+)$/i;

function followUpTail(text) {
  const m = String(text || '').trim().replace(/[?.!]+$/, '').match(FOLLOWUP_RX);
  return m ? m[4].trim() : null;
}

module.exports = {
  recall,
  remember,
  setPending,
  takePending,
  clearPending,
  clear,
  isAffirmation,
  isNegation,
  referencesLastPatient,
  resolvePronouns,
  followUpTail,
};
