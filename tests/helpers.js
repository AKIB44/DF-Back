const request = require('supertest');

const BASE = 'http://localhost:3000';

/** Authenticated supertest helpers */
const api = {
  get:    (url) => request(BASE).get(url).set('Authorization', `Bearer ${process.env.TEST_ACCESS_TOKEN}`),
  post:   (url) => request(BASE).post(url).set('Authorization', `Bearer ${process.env.TEST_ACCESS_TOKEN}`),
  patch:  (url) => request(BASE).patch(url).set('Authorization', `Bearer ${process.env.TEST_ACCESS_TOKEN}`),
  put:    (url) => request(BASE).put(url).set('Authorization', `Bearer ${process.env.TEST_ACCESS_TOKEN}`),
  delete: (url) => request(BASE).delete(url).set('Authorization', `Bearer ${process.env.TEST_ACCESS_TOKEN}`),
  /** Un-authenticated */
  anon:   () => request(BASE),
};

/** Tomorrow at 10:00 IST */
function tomorrowSlot() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.toISOString().slice(0, 10)}T10:00:00+05:30`;
}

/** Today ISO date */
function todayIso() { return new Date().toISOString().slice(0, 10); }

module.exports = { api, tomorrowSlot, todayIso };
