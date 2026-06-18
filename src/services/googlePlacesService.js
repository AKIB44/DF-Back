'use strict';

// Google Places API client for the Lead Finder (enrichment + optional discovery).
// ToS-compliant alternative/complement to scraping. Activates only when
// GOOGLE_PLACES_API_KEY is set; otherwise every method is a graceful no-op so the
// app runs without billing configured. Uses Node 18+ global fetch (no new deps).
//
// Guardrails:
//   • every network call is bounded by PLACES_TIMEOUT_MS (AbortController)
//   • an optional `meter` ({ calls, cap }) counts billable calls and throws
//     BUDGET_EXHAUSTED before exceeding the caller's remaining daily budget.

const API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const BASE = 'https://maps.googleapis.com/maps/api/place';
const TIMEOUT_MS = Number(process.env.PLACES_TIMEOUT_MS || 8000);

function isEnabled() {
  return !!API_KEY;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Count one billable call; throw before exceeding the budget.
function meterTick(meter) {
  if (!meter) return;
  if (meter.cap != null && meter.calls >= meter.cap) {
    const e = new Error('Places API daily call budget exhausted');
    e.code = 'BUDGET_EXHAUSTED';
    throw e;
  }
  meter.calls++;
}

async function getJson(url, meter) {
  meterTick(meter);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Places API HTTP ${res.status}`);
    const body = await res.json();
    if (body.status && !['OK', 'ZERO_RESULTS'].includes(body.status)) {
      throw new Error(`Places API: ${body.status}${body.error_message ? ' — ' + body.error_message : ''}`);
    }
    return body;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Places API timed out after ${TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Text search for discovery, e.g. "dental clinic in Pune".
// Follows next_page_token (max 3 pages / ~60 results) until `limit` is reached.
async function textSearch(query, { limit = 20, meter } = {}) {
  if (!API_KEY) return [];
  const out = [];
  let url = `${BASE}/textsearch/json?query=${encodeURIComponent(query)}&region=in&key=${API_KEY}`;
  for (let page = 0; page < 3 && out.length < limit; page++) {
    const body = await getJson(url, meter);
    for (const r of (body.results || [])) {
      out.push({
        name:      r.name,
        address:   r.formatted_address,
        rating:    r.rating ?? null,
        category:  (r.types || [])[0] || null,
        place_id:  r.place_id,
        website:   null,
        phone_raw: null,
      });
    }
    if (!body.next_page_token || out.length >= limit) break;
    await sleep(2000);   // token activation delay
    url = `${BASE}/textsearch/json?pagetoken=${body.next_page_token}&key=${API_KEY}`;
  }
  return out.slice(0, limit);
}

// Resolve a free-text name (e.g. "Smile Dental Pune") to a place_id for enrichment.
async function findPlace(input, meter) {
  if (!API_KEY || !input) return null;
  const url = `${BASE}/findplacefromtext/json?input=${encodeURIComponent(input)}&inputtype=textquery&fields=place_id&key=${API_KEY}`;
  const body = await getJson(url, meter);
  return (body.candidates || [])[0]?.place_id || null;
}

// Place Details — fills in phone + website for a place_id.
async function placeDetails(placeId, meter) {
  if (!API_KEY || !placeId) return null;
  const fields = 'name,formatted_address,formatted_phone_number,international_phone_number,website,rating,types';
  const url = `${BASE}/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&region=in&key=${API_KEY}`;
  const body = await getJson(url, meter);
  const r = body.result;
  if (!r) return null;
  return {
    name:      r.name,
    address:   r.formatted_address,
    phone_raw: r.international_phone_number || r.formatted_phone_number || null,
    website:   r.website || null,
    rating:    r.rating ?? null,
    category:  (r.types || [])[0] || null,
  };
}

module.exports = { isEnabled, textSearch, findPlace, placeDetails };
