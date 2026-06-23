'use strict';

// Guardrails for the Lead Finder's paid Google Places API usage.
// Enforces, per clinic per day: a search-run cap, a billable-call cap, a cooldown
// between searches, and in-flight dedupe of identical concurrent searches. Also a
// TTL result cache so repeat searches cost nothing. All limits are env-tunable.

const db = require('../db');

const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const CAP_SEARCHES = int(process.env.PLACES_DAILY_SEARCH_CAP, 50);   // /search runs / clinic / day
const CAP_CALLS    = int(process.env.PLACES_DAILY_CALL_CAP, 500);    // billable calls / clinic / day
const COOLDOWN_SEC = int(process.env.PLACES_SEARCH_COOLDOWN_SEC, 5); // min gap between searches
const CACHE_TTL_H  = int(process.env.PLACES_CACHE_TTL_HOURS, 168);   // 7 days

const limits = () => ({ daily_search_cap: CAP_SEARCHES, daily_call_cap: CAP_CALLS, cooldown_sec: COOLDOWN_SEC, cache_ttl_hours: CACHE_TTL_H });

// In-process guard against duplicate concurrent searches (per clinic+key).
const inFlight = new Set();

class GuardError extends Error {
  constructor(code, message) { super(message); this.name = 'GuardError'; this.code = code; this.status = 429; }
}

function cacheKey(query, city, limit) {
  return `${(query || '').trim()}|${(city || '').trim()}|${limit}`.toLowerCase();
}

async function todayUsage(clinicId) {
  const { rows } = await db.query(
    `SELECT search_count, api_calls, last_search_at
       FROM mkt_places_usage WHERE clinic_id = $1 AND usage_date = CURRENT_DATE`,
    [clinicId]
  );
  return rows[0] || { search_count: 0, api_calls: 0, last_search_at: null };
}
 
// Enforce caps/cooldown/dedupe and RESERVE a search slot. Returns a token to pass
// to release(), plus the remaining call budget for the meter. Throws GuardError.
async function reserve(clinicId, key) {
  const flightKey = `${clinicId}|${key}`;
  if (inFlight.has(flightKey)) {
    throw new GuardError('SEARCH_IN_PROGRESS', 'An identical search is already running — please wait.');
  }

  const u = await todayUsage(clinicId);
  if (u.last_search_at && Date.now() - new Date(u.last_search_at).getTime() < COOLDOWN_SEC * 1000) {
    throw new GuardError('COOLDOWN', `Please wait ${COOLDOWN_SEC}s between searches.`);
  }
  if (u.search_count >= CAP_SEARCHES) {
    throw new GuardError('DAILY_SEARCH_CAP', `Daily search limit reached (${CAP_SEARCHES}/day). Try again tomorrow.`);
  }
  if (u.api_calls >= CAP_CALLS) {
    throw new GuardError('DAILY_CALL_CAP', `Daily Places API call limit reached (${CAP_CALLS}/day).`);
  }

  await db.query(
    `INSERT INTO mkt_places_usage (clinic_id, usage_date, search_count, last_search_at)
     VALUES ($1, CURRENT_DATE, 1, NOW())
     ON CONFLICT (clinic_id, usage_date)
     DO UPDATE SET search_count = mkt_places_usage.search_count + 1, last_search_at = NOW()`,
    [clinicId]
  );
  inFlight.add(flightKey);
  return { flightKey, remainingCalls: Math.max(0, CAP_CALLS - u.api_calls) };
}

function release(flightKey) {
  if (flightKey) inFlight.delete(flightKey);
}

async function recordCalls(clinicId, n) {
  if (!n) return;
  await db.query(
    `INSERT INTO mkt_places_usage (clinic_id, usage_date, api_calls)
     VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (clinic_id, usage_date)
     DO UPDATE SET api_calls = mkt_places_usage.api_calls + $2`,
    [clinicId, n]
  );
}

async function getCache(clinicId, key) {
  const { rows } = await db.query(
    `SELECT payload FROM mkt_places_cache
      WHERE clinic_id = $1 AND cache_key = $2
        AND created_at > NOW() - ($3 || ' hours')::interval`,
    [clinicId, key, String(CACHE_TTL_H)]
  );
  return rows[0]?.payload || null;
}

async function setCache(clinicId, key, payload) {
  await db.query(
    `INSERT INTO mkt_places_cache (clinic_id, cache_key, provider, payload, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (clinic_id, cache_key)
     DO UPDATE SET payload = $4, provider = $3, created_at = NOW()`,
    [clinicId, key, payload.provider, JSON.stringify(payload)]
  );
}

async function usage(clinicId) {
  const u = await todayUsage(clinicId);
  return {
    date: new Date().toISOString().slice(0, 10),
    searches_used: u.search_count,
    api_calls_used: u.api_calls,
    searches_remaining: Math.max(0, CAP_SEARCHES - u.search_count),
    calls_remaining: Math.max(0, CAP_CALLS - u.api_calls),
    last_search_at: u.last_search_at,
    limits: limits(),
  };
}

module.exports = { cacheKey, reserve, release, recordCalls, getCache, setCache, usage, limits, GuardError };
