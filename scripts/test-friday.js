#!/usr/bin/env node
// Friday NLU sandbox
//
//   node scripts/test-friday.js "open patient ravi"
//   node scripts/test-friday.js --suite
//   node scripts/test-friday.js --calibrate
//   node scripts/test-friday.js --misses

const path = require('path');
const fs   = require('fs');
const { classify } = require('../src/ai/friday-nlu');

const SUITE = [
  // [expected intent, phrase, optional entity assertions]
  ['patient.find', 'open patient ravi'],
  ['patient.find', 'show me asha mehta', { query: 'asha mehta' }],
  ['patient.find', 'pull up 9876543210', { query: '9876543210' }],
  ['patient.find', 'who is ravi sharma', { query: 'ravi sharma' }],
  ['patient.find', 'open opg of ravi', { query: 'ravi' }],
  ['patient.find', 'open dental chart of asha', { query: 'asha' }],
  ['patient.find', 'find uhid 12345', { query: '12345' }],
  ['patient.find', 'show me records of patient Paras', { query: 'paras' }],
  ['patient.find', 'show me the records of patient paras gupta', { query: 'paras gupta' }],
  ['patient.find', 'get patient records for paras', { query: 'paras' }],
  ['patient.find', 'review case of paras gupta', { query: 'paras gupta' }],
  ['patient.find', 'show cbct of paras', { query: 'paras' }],
  ['navigate', 'open schedule'],
  ['navigate', 'take me to inventory'],
  ['navigate', 'open prescriptions'],
  ['navigate', 'show patients'],
  ['navigate', 'open ortho cases'],
  ['navigate', 'open implant cases'],
  ['navigate', 'open billing page'],
  ['appointment.book', 'book a cleaning for ravi tomorrow at 10'],
  ['appointment.book', 'schedule extraction for asha'],
  ['appointment.book', 'book rct for ravi'],
  ['appointment.book', 'book wisdom tooth extraction'],
  ['appointment.book', 'book scaling and polishing'],
  ['appointment.book', 'book zirconia crown for ravi'],
  ['appointment.book', 'book pulpectomy for child'],
  ['appointment.book', 'book implant placement'],
  ['appointment.book', 'book ortho adjustment'],
  ['schedule.summary', "what's on today"],
  ['schedule.summary', 'how many patients today'],
  ['schedule.summary', 'any cancellations today'],
  ['schedule.summary', 'who is my next patient'],
  ['schedule.time', 'who is at 3pm today', { time: '15:00' }],
  ['schedule.time', 'appointments at 10am tomorrow'],
  ['schedule.time', 'anything open at 4 today'],
  ['schedule.time', 'morning appointments today', { period: 'morning' }],
  ['schedule.time', 'who is in chair 1 at 3pm', { chair: '1', time: '15:00' }],
  ['agent.proactive', 'remind me when next patient checks in'],
  ['agent.proactive', 'friday what should i do next'],
  ['agent.proactive', 'notify me of cancellations'],
  ['agent.proactive', 'keep me posted on delays'],
  ['behaviour', 'speak louder', { action: 'speak_louder' }],
  ['behaviour', 'talk slower friday', { action: 'speak_slower' }],
  ['behaviour', 'repeat that', { action: 'repeat' }],
  ['behaviour', 'confirm before acting', { action: 'confirm_before_act' }],
  ['behaviour', 'mute yourself', { action: 'mute' }],
  ['behaviour', 'speak hindi', { action: 'language_hindi' }],
  ['behaviour', 'workaholic mode on', { action: 'workaholic_mode' }],
  ['app.exit', 'fine just logout', { tone: 'sarcastic', reason: 'exit_app' }],
  ['app.exit', 'log me out friday', { tone: 'direct', reason: 'exit_app' }],
  ['app.exit', 'im leaving early close the app', { tone: 'sarcastic', reason: 'leaving_early' }],
  ['app.exit', 'whatever leaving early logout', { tone: 'sarcastic', reason: 'leaving_early' }],
  ['smalltalk.greeting', 'hi friday'],
  ['smalltalk.greeting', 'good morning friday'],
  ['smalltalk.greeting', 'how are you doing'],
  ['smalltalk.thanks', 'thanks friday'],
  ['smalltalk.thanks', 'thank you so much'],
  ['smalltalk.bye', 'goodbye friday'],
  ['smalltalk.bye', 'thats all for today'],
  ['smalltalk.time', 'what time is it'],
  ['smalltalk.time', 'todays date please'],
  ['smalltalk.weather', 'how is the weather today'],
  ['smalltalk.weather', 'will it rain today'],
  ['smalltalk.sarcasm', 'tell me a joke'],
  ['smalltalk.sarcasm', 'are you a robot'],
  ['smalltalk.sarcasm', 'do you love me'],
  ['smalltalk.sarcasm', 'can you do a root canal on me'],
  ['smalltalk.sarcasm', 'friday whats my pulp status'],
  ['unknown', 'play some music'],
  ['unknown', 'order a pizza'],
  ['patient.find', 'who is Paras', { query: 'paras' }],
  ['billing.patient', 'how much does paras owe', { query: 'paras', aspect: 'due' }],
  ['billing.patient', 'due amount for paras gupta', { query: 'paras gupta', aspect: 'due' }],
  ['billing.patient', 'what is paras final amount', { query: 'paras', aspect: 'total' }],
  ['billing.patient', 'patient ravi balance due', { query: 'ravi', aspect: 'due' }],
  ['billing.patient', 'total bill for asha mehta', { query: 'asha mehta', aspect: 'total' }],
  ['billing.patient', 'how much is patient paras due', { query: 'paras', aspect: 'due' }],
  ['billing.patient', 'outstanding amount for ravi sharma', { query: 'ravi sharma', aspect: 'due' }],
  ['smalltalk.greeting', 'friday'],
  ['smalltalk.weather', 'what is the weather'],
];

function pad(s, n) { return String(s).padEnd(n, ' '); }

function checkEntry(expected, phrase, spec = {}) {
  const { redirect, ...entities } = spec;
  const r = classify(phrase);
  const intentOk = r.intent === expected;
  let entityOk = true;
  if (Object.keys(entities).length && intentOk) {
    for (const [k, v] of Object.entries(entities)) {
      const got = r.entities?.[k];
      if (got === undefined || got === null) { entityOk = false; continue; }
      if (String(got).toLowerCase() !== String(v).toLowerCase()) {
        entityOk = false;
      }
    }
  }
  const timeOk = !entities.period || r.time_context?.period === entities.period
    || r.entities?.period === entities.period;
  if (entities.period && intentOk && !timeOk) entityOk = false;
  if (redirect && intentOk && r.action?.redirect !== redirect) entityOk = false;
  if (intentOk && expected === 'app.exit' && r.action?.type !== 'logout') entityOk = false;
  if (intentOk && expected === 'app.exit' && !r.action?.redirect) entityOk = false;
  if (intentOk && expected === 'app.exit' && r.action?.clear_local_auth !== true) entityOk = false;
  return { r, ok: intentOk && entityOk };
}

function single(phrase) {
  const r = classify(phrase);
  console.log(JSON.stringify(r, null, 2));
}

function suite() {
  let pass = 0;
  for (const [expected, phrase, entities] of SUITE) {
    const { r, ok } = checkEntry(expected, phrase, entities);
    if (ok) pass++;
    const mark = ok ? '\x1b[32m?\x1b[0m' : '\x1b[31m?\x1b[0m';
    console.log(`${mark}  ${pad(r.intent, 18)} conf=${r.confidence.toFixed(3)}  ${phrase}`);
    if (!ok) {
      console.log(`     expected ${expected}, entities=${JSON.stringify(r.entities)}`);
      if (entities) console.log(`     want entities=${JSON.stringify(entities)}`);
    }
  }
  console.log(`\n${pass}/${SUITE.length} passing`);
  process.exit(pass === SUITE.length ? 0 : 1);
}

function misses() {
  const file = path.join(__dirname, '..', 'data', 'friday-misses.log');
  if (!fs.existsSync(file)) { console.log('No misses logged yet.'); return; }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const recent = lines.slice(-20);
  for (const l of recent) console.log(l);
  console.log(`\n(${recent.length} of ${lines.length} total  review and add good ones to data/friday-training.json)`);
}

function calibrate() {
  const byIntent = {};
  let pass = 0;
  for (const [expected, phrase, entities] of SUITE) {
    const { r, ok } = checkEntry(expected, phrase, entities);
    if (ok) pass++;
    if (!byIntent[expected]) byIntent[expected] = [];
    if (expected !== 'unknown') byIntent[expected].push({ phrase, conf: r.confidence, ok });
  }
  console.log('\nConfidence report (honest scores  no artificial calibration)\n');
  let total = 0, count = 0;
  for (const [intent, rows] of Object.entries(byIntent)) {
    const confs = rows.filter(r => r.ok).map(r => r.conf);
    const avg = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    console.log(`  ${pad(intent, 20)} avg=${avg.toFixed(3)}  n=${confs.length}`);
    for (const r of rows) {
      const mark = r.ok ? '  ' : 'x ';
      console.log(`    ${mark}${r.conf.toFixed(3)}  ${r.phrase}`);
    }
    total += confs.reduce((a, b) => a + b, 0);
    count += confs.length;
  }
  const overall = count ? total / count : 0;
  console.log(`\nOverall avg confidence: ${overall.toFixed(3)} (${pass}/${SUITE.length} correct)`);
  process.exit(pass === SUITE.length ? 0 : 1);
}

const arg = process.argv[2];
if (!arg)              { console.log('usage: node scripts/test-friday.js "phrase" | --suite | --calibrate | --misses'); process.exit(0); }
else if (arg === '--suite')      suite();
else if (arg === '--calibrate')  calibrate();
else if (arg === '--misses')     misses();
else                             single(process.argv.slice(2).join(' '));
