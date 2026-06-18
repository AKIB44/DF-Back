'use strict';

// Lead screening for the Lead Finder (PRD marketing module).
// Normalizes + validates Indian phone numbers and decides whether a discovered
// Google Maps result is worth keeping as a lead. Dedupe against existing clinics
// (active subscribers) and existing pipeline leads happens in the route, where DB
// access lives; this module is pure (easy to unit-test).

// Normalize a raw phone string to E.164-ish +91XXXXXXXXXX, or null if it can't
// be made into a plausible 10-digit Indian subscriber number.
function normalizeIndianPhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d]/g, '');
  // Strip country code / trunk prefixes.
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  else if (digits.length === 13 && digits.startsWith('091')) digits = digits.slice(3);
  if (digits.length !== 10) return null;
  // Indian mobile + most landline subscriber numbers start 2–9 (mobiles 6–9).
  if (!/^[2-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

function isMobile(normalized) {
  return /^\+91[6-9]\d{9}$/.test(normalized || '');
}

// Screen a single raw result. Returns { status, phone, reject_reason }.
// status: 'passed' | 'no_phone' | 'invalid_phone'  (dedupe handled by caller).
function screen(result) {
  const rawPhone = result.phone_raw || result.phone || null;
  if (!rawPhone) return { status: 'no_phone', phone: null, reject_reason: 'No phone number listed' };
  const phone = normalizeIndianPhone(rawPhone);
  if (!phone) return { status: 'invalid_phone', phone: null, reject_reason: `Unrecognized phone format: ${rawPhone}` };
  return { status: 'passed', phone, reject_reason: null };
}

module.exports = { normalizeIndianPhone, isMobile, screen };
