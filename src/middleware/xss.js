/**
 * XSS input sanitizer.
 *
 * Walks every string value in req.body / req.query / req.params and strips
 * constructs that could become executable in a browser if the data is ever
 * rendered without escaping — script tags, event handlers, javascript: and
 * data: URIs, CSS expression(), null bytes, and Unicode direction-override
 * characters used in reflected-XSS bypasses.
 *
 * This is a defence-in-depth layer. The frontend must still escape output, but
 * this ensures nothing dangerous is ever persisted to the database in the first
 * place.
 */

// Patterns ordered most-specific → most-general
const RULES = [
  // Complete <script> blocks (multiline)
  [/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis,             ''],
  // <style> blocks
  [/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis,               ''],
  // HTML comments (can hide payloads: <!--<script>-->)
  [/<!--[\s\S]*?-->/g,                                                  ''],
  // All remaining HTML/SVG tags
  [/<[^>]+>/g,                                                          ''],
  // javascript: and vbscript: pseudo-protocols (with optional whitespace/encoding)
  [/\b(javascript|vbscript)\s*:/gi,                                     ''],
  // data: URIs (used for base64-encoded payloads in <img src="data:...">)
  [/\bdata\s*:/gi,                                                      ''],
  // Inline event handlers: onclick=, onmouseover=, onerror=, etc.
  [/\bon\w+\s*=/gi,                                                     ''],
  // CSS expression() — executes JS in older IE
  [/expression\s*\(/gi,                                                  ''],
  // Null bytes and C0 control chars (used to bypass filters)
  // eslint-disable-next-line no-control-regex
  [/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,                                   ''],
  // Unicode bidirectional override characters (trojan-source attack)
  [/[​-‍‪-‮⁦-⁩﻿]/g,                ''],
];

function sanitizeString(value) {
  let s = value;
  for (const [pattern, replacement] of RULES) {
    s = s.replace(pattern, replacement);
  }
  return s.trim();
}

function sanitizeValue(value, depth = 0) {
  if (depth > 10) return value; // prevent deeply nested prototype pollution
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value))     return value.map(v => sanitizeValue(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Skip prototype-polluting keys
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

module.exports = (req, res, next) => {
  if (req.body   && typeof req.body   === 'object') req.body   = sanitizeValue(req.body);
  if (req.query  && typeof req.query  === 'object') req.query  = sanitizeValue(req.query);
  if (req.params && typeof req.params === 'object') req.params = sanitizeValue(req.params);
  next();
};
