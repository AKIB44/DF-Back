'use strict';

// Lead Finder orchestrator — the "hybrid" data layer (PRD marketing module).
// Discovery: Playwright scrape if available, else Places API text search, else a
// clearly-labelled MOCK provider so the screen→import flow is testable without
// keys or a browser. Enrichment: when the Places API is configured, fill missing
// phone/website for discovered results. The route handles screening + DB dedupe.

const scraper = require('./googleMapsScraperService');
const places  = require('./googlePlacesService');

// Sample data so the feature is demonstrable with no API key / no Playwright.
// Intentionally varied (missing phone, malformed phone, a likely-duplicate) so
// screening exercises every status. Clearly flagged provider='mock' in responses.
function mockResults(city) {
  const c = city || 'Pune';
  return [
    { name: 'Bright Smile Dental',     address: `MG Road, ${c}`,        phone_raw: '+91 98000 00001', website: 'https://brightsmile.in', rating: 4.6, category: 'dentist' },
    { name: 'Pearl Dental Care',       address: `FC Road, ${c}`,        phone_raw: '098000 00012',    website: null,                    rating: 4.3, category: 'dentist' },
    { name: 'Smile Studio Dental',     address: `Baner, ${c}`,          phone_raw: '+91-80000-00013', website: 'https://smilestudio.in',rating: 4.8, category: 'dental_clinic' },
    { name: 'City Dental Hospital',    address: `Kothrud, ${c}`,        phone_raw: '02041000000',     website: null,                    rating: 4.1, category: 'dentist' },
    { name: 'Happy Teeth Clinic',      address: `Viman Nagar, ${c}`,    phone_raw: '9820000015',      website: null,                    rating: 4.5, category: 'dentist' },
    { name: 'Ortho Plus Dental',       address: `Hadapsar, ${c}`,       phone_raw: '+91 73000 00016', website: 'https://orthoplus.in',  rating: 4.0, category: 'dental_clinic' },
    { name: 'Gentle Dental (no phone)',address: `Aundh, ${c}`,          phone_raw: null,              website: 'https://gentledental.in',rating: 4.2, category: 'dentist' },
    { name: 'QuickDent Express',       address: `Wakad, ${c}`,          phone_raw: '12345',           website: null,                    rating: 3.4, category: 'dentist' },
  ];
}

function status() {
  return { scraper_available: scraper.isAvailable(), places_enabled: places.isEnabled() };
}

// Enrich results missing a phone via the Places API (best-effort).
// `meter` enforces the caller's remaining daily call budget; we stop cleanly when
// it's reached rather than erroring the whole search.
async function enrich(results, city, meter) {
  if (!places.isEnabled()) return;
  for (const r of results) {
    if (r.phone_raw) continue;
    if (meter && meter.cap != null && meter.calls >= meter.cap) break;
    try {
      const placeId = r.place_id || await places.findPlace([r.name, city].filter(Boolean).join(' '), meter);
      if (!placeId) continue;
      const d = await places.placeDetails(placeId, meter);
      if (d) {
        r.phone_raw = r.phone_raw || d.phone_raw;
        r.website   = r.website   || d.website;
        r.rating    = r.rating    ?? d.rating;
        r.category  = r.category  || d.category;
        r.place_id  = r.place_id  || placeId;
        r.enriched  = true;
      }
    } catch (_) { /* skip enrichment failures */ }
  }
}

/**
 * Discover clinic leads. Returns { provider, results: [...] }.
 * @param {{ query: string, city?: string, limit?: number }} opts
 */
async function discover({ query, city, limit = 20, meter }) {
  let provider;
  let results = [];

  if (scraper.isAvailable()) {
    provider = 'scrape';
    results = await scraper.scrape({ query, city, limit });
  } else if (places.isEnabled()) {
    provider = 'places';
    results = await places.textSearch([query, city].filter(Boolean).join(' '), { limit, meter });
  } else {
    provider = 'mock';
    results = mockResults(city);
  }

  results = results.slice(0, limit).map((r) => ({ enriched: false, ...r }));
  await enrich(results, city, meter);   // no-op unless Places API is configured
  return { provider, results };
}

module.exports = { discover, status };
