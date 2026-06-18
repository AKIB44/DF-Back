'use strict';

// Google Maps scraper for the Lead Finder (discovery).
//
// ⚠️ Scraping Google Maps violates Google's Terms of Service and is brittle
// (layout changes, consent walls, CAPTCHA, IP blocks). Prefer the Places API
// (googlePlacesService) where possible; this is the "breadth" half of the hybrid.
//
// Playwright is an OPTIONAL dependency: it is lazy-required so the backend runs
// without it. To enable scraping:  npm i playwright && npx playwright install chromium
// Selectors are best-effort and will need maintenance as Google changes its DOM.

let _playwright = null;
function loadPlaywright() {
  if (_playwright === null) {
    try { _playwright = require('playwright'); }
    catch (_) { _playwright = false; }   // not installed
  }
  return _playwright;
}

function isAvailable() {
  return !!loadPlaywright();
}

// Scrape up to `limit` results for "<query> in <city>".
// Returns [{ name, address, phone_raw, website, rating, category, place_id }].
async function scrape({ query, city, limit = 20 }) {
  const playwright = loadPlaywright();
  if (!playwright) throw new Error('Scraper unavailable — install playwright (npm i playwright && npx playwright install chromium)');

  const term = [query, city].filter(Boolean).join(' ');
  const url = `https://www.google.com/maps/search/${encodeURIComponent(term)}?hl=en`;

  const browser = await playwright.chromium.launch({ headless: true });
  const results = [];
  try {
    const ctx = await browser.newContext({
      locale: 'en-US',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Dismiss the consent wall if present.
    for (const sel of ['button[aria-label*="Accept"]', 'button:has-text("Accept all")', 'form[action*="consent"] button']) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) { await btn.click().catch(() => {}); break; }
    }

    const feed = 'div[role="feed"]';
    await page.waitForSelector(feed, { timeout: 20000 });

    // Lazy-scroll the results feed until enough cards load (or it stops growing).
    let prev = 0;
    for (let i = 0; i < 12; i++) {
      const count = await page.$$eval(`${feed} a[href*="/maps/place/"]`, (els) => els.length).catch(() => 0);
      if (count >= limit || count === prev) break;
      prev = count;
      await page.$eval(feed, (el) => el.scrollBy(0, el.scrollHeight)).catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Extract the basics from each card. Phone/website usually require opening the
    // place; we capture what the card exposes and leave the rest to Places enrich.
    const cards = await page.$$eval(`${feed} > div > div[jsaction]`, (nodes) => nodes.map((n) => {
      const nameEl = n.querySelector('a[href*="/maps/place/"]');
      const name = nameEl?.getAttribute('aria-label') || nameEl?.textContent?.trim() || null;
      const href = nameEl?.getAttribute('href') || null;
      const text = n.innerText || '';
      const ratingMatch = text.match(/(\d\.\d)\s*\(/);
      const phoneMatch = text.match(/(\+?\d[\d\s\-]{7,}\d)/);
      const addrLine = text.split('\n').find((l) => /\d/.test(l) && l.length > 8 && !l.includes('·')) || null;
      return {
        name,
        address: addrLine,
        rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
        phone_raw: phoneMatch ? phoneMatch[1] : null,
        website: null,
        category: null,
        href,
      };
    })).catch(() => []);

    for (const c of cards) {
      if (!c.name) continue;
      results.push({ ...c, place_id: null });
      if (results.length >= limit) break;
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return results;
}

module.exports = { isAvailable, scrape };
