#!/usr/bin/env node
// Regenerate data/friday-training.json — DentaFlow Friday NLU corpus.
// Run: node scripts/build-friday-training.js

const fs = require('fs');
const path = require('path');

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

const PATIENTS = [
  'ravi sharma', 'asha mehta', 'priya patel', 'suresh kumar', 'kavya singh',
  'ramesh iyer', 'neha desai', 'amit joshi', 'paras gupta', 'deepa nair',
  'vikram reddy', 'anita gupta', 'sneha kapoor', 'rahul verma', 'meera shah',
  'arjun malhotra', 'pooja agarwal', 'sanjay chopra', 'divya rao', 'kiran bhat',
];

const PHONES = ['9876543210', '9820123456', '8765432109', '9988776655', '9123456780'];

const TIMES = [
  '8am', '9am', '9:30am', '10am', '10:30am', '11am', '12pm', '1pm', '2pm', '2:30pm',
  '3pm', '3:30pm', '4pm', '4:30pm', '5pm', '5:30pm', '6pm', '7pm', '8pm',
  'noon', 'midday', 'morning', 'afternoon', 'evening',
];

const DAYS = ['today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ── Dental / medical vocabulary (from DentaFlow seeds, specialty migrations, rx master) ──
const DENTAL_PROCEDURES = [
  'oral prophylaxis', 'scaling and polishing', 'subgingival scaling', 'root planing',
  'composite restoration', 'amalgam restoration', 'gic restoration', 'inlay onlay',
  'root canal treatment', 'rct', 'access opening', 'biomechanical preparation', 'obturation',
  'post and core', 'crown preparation', 'pfm crown', 'zirconia crown', 'emax crown',
  'bridge cementation', 'veneer preparation', 'veneer bonding', 'simple extraction',
  'surgical extraction', 'wisdom tooth removal', 'impacted third molar extraction',
  'alveoloplasty', 'frenectomy', 'gingivectomy', 'flap surgery', 'crown lengthening',
  'sinus lift', 'bone graft', 'ridge augmentation', 'implant placement', 'implant uncovering',
  'abutment placement', 'implant crown delivery', 'sinus augmentation', 'socket preservation',
  'pulpectomy', 'pulpotomy', 'apexogenesis', 'apexification', 'apicoectomy', 'retreatment',
  'direct pulp cap', 'indirect pulp cap', 'stainless steel crown', 'space maintainer',
  'fluoride varnish', 'pit and fissure sealant', 'habit breaking appliance',
  'ortho consultation', 'bracket bonding', 'wire adjustment', 'archwire change',
  'elastic configuration', 'debond and polish', 'fixed retainer', 'clear aligner check',
  'invisalign review', 'tmj splint delivery', 'splint adjustment', 'occlusal equilibration',
  'complete denture', 'partial denture', 'denture relining', 'denture rebasing',
  'bleaching', 'in office whitening', 'home bleaching tray', 'checkup', 'recall visit',
  'emergency visit', 'suture removal', 'dry socket management', 'incision and drainage',
];

const DENTAL_DIAGNOSTIC = [
  'opg', 'cbct', 'iopa', 'bitewing radiograph', 'periapical radiograph', 'cephalometric xray',
  'pulp vitality test', 'cold test', 'electric pulp test', 'percussion test', 'palpation',
  'mobility assessment', 'periodontal probing', 'bleeding on probing', 'plaque index',
  'gingival index', 'caries risk assessment', 'tmj palpation', 'range of motion test',
  'study models', 'intraoral scan', 'facebow record', 'shade matching', 'bite registration',
];

const DENTAL_CHART_TERMS = [
  'odontogram', 'dental chart', 'periodontal chart', 'fdi notation chart', 'tooth chart',
  'clinical notes', 'progress notes', 'treatment plan', 'consent form', 'medical history',
  'allergy list', 'medication list', 'vitals chart', 'bp log', 'diabetes notes',
  'post op instructions', 'lab requisition', 'histopathology report', 'biopsy report',
  'implant chart', 'endo record', 'ortho records', 'paedo growth chart', 'tmj evaluation',
];

const PHARMA_TERMS = [
  'amoxicillin', 'augmentin', 'metronidazole', 'azithromycin', 'doxycycline',
  'ibuprofen', 'combiflam', 'paracetamol', 'dolo', 'diclofenac', 'voveran',
  'pantoprazole', 'chlorhexidine mouthwash', 'hexidine', 'clove oil', 'eugenol',
  'lignocaine gel', 'xylocaine', 'fluoride varnish', 'prescription pad', 'rx pad',
];

const LAB_INVENTORY = [
  'lab order', 'crown work', 'bridge work', 'denture lab', 'zirconia milling',
  'porcelain build up', 'implant prosthesis', 'night guard', 'splint lab work',
  'composite stock', 'gutta percha', 'sealer', 'implant fixture', 'healing abutment',
  'ortho wire', 'brackets kit', 'anaesthetic cartridge', 'gloves stock', 'mask inventory',
];

const training = {
  _meta: {
    note: 'DentaFlow Friday NLU v6 — v5 + real-world conversational upgrade: jokes/summon intents, Hinglish, casual phrasings, misses-log promotion, expanded schedule summary. Rebuild: node scripts/build-friday-training.js',
    confidence_floor: 0.18,
    version: '6.0',
    updated: new Date().toISOString().slice(0, 10),
    intents: [
      'patient.find', 'billing.patient', 'navigate', 'appointment.book', 'schedule.summary', 'schedule.time',
      'agent.proactive', 'behaviour', 'smalltalk.greeting', 'smalltalk.time', 'smalltalk.weather',
      'smalltalk.sarcasm', 'smalltalk.thanks', 'smalltalk.bye', 'app.exit',
      'smalltalk.identity', 'smalltalk.help', 'smalltalk.howareyou', 'smalltalk.compliment',
      'smalltalk.joke', 'smalltalk.summon',
    ],
  },
  'patient.find': [],
  'billing.patient': [],
  'app.exit': [],
  'navigate': [],
  'appointment.book': [],
  'schedule.summary': [],
  'schedule.time': [],
  'agent.proactive': [],
  'behaviour': [],
  'smalltalk.greeting': [],
  'smalltalk.time': [],
  'smalltalk.weather': [],
  'smalltalk.sarcasm': [],
  'smalltalk.thanks': [],
  'smalltalk.bye': [],
  'smalltalk.identity': [],
  'smalltalk.help': [],
  'smalltalk.howareyou': [],
  'smalltalk.compliment': [],
  'smalltalk.joke': [],
  'smalltalk.summon': [],
};

const pf = training['patient.find'];

// ── Receptionist persona ──
for (const p of PATIENTS) {
  const first = p.split(' ')[0];
  pf.push(
    `open patient ${p}`, `show patient ${p}`, `find patient ${first}`, `lookup patient ${first}`,
    `show me ${p}`, `show me records of patient ${first}`, `show me records of patient ${p}`,
    `show me the records of patient ${first}`, `show me patient records for ${first}`,
    `get patient records for ${first}`, `pull up patient ${first}`, `pull up ${p}`,
    `patient ${first} is here`, `check in patient ${first}`, `register walk in ${first}`,
    `patient ${first} waiting`, `call patient ${first}`, `send reminder to ${first}`,
    `confirm appointment for ${first}`, `patient ${first} arrived`, `late patient ${first}`,
  );
}

// ── Doctor persona + clinical records ──
for (const p of PATIENTS.slice(0, 15)) {
  const first = p.split(' ')[0];
  for (const term of DENTAL_CHART_TERMS) {
    pf.push(`open ${term} of ${first}`, `show ${term} for ${first}`, `show me ${term} of patient ${first}`);
  }
  for (const dx of DENTAL_DIAGNOSTIC.slice(0, 12)) {
    pf.push(`show ${dx} of ${first}`, `review ${dx} for ${first}`, `open ${dx} report of ${first}`);
  }
  pf.push(
    `review case of ${first}`, `clinical assessment of ${first}`, `examine chart of ${first}`,
    `show allergies for ${first}`, `check comorbidities of ${first}`, `open surgical notes of ${first}`,
    `show implant chart of ${first}`, `review endo record of ${first}`, `show ortho progress of ${first}`,
  );
}

for (const ph of PHONES) {
  pf.push(`pull up ${ph}`, `find phone ${ph}`, `lookup ${ph}`, `search by phone ${ph}`);
}

pf.push(
  'search patient by name', 'find uhid 12345', 'search uhid 12345', 'who is paras', 'who is paras gupta',
  'find by aadhaar', 'search by uhid', 'open patient file', 'patient lookup',
  // casual + single-name real-world usage
  'who is ravi', 'who is asha', 'who is priya', 'whos this ravi guy',
  'ravi ka record kholo', 'asha ki file dikhao', 'patient ravi ka chart',
  'us patient ko kholo', 'ravi ko dhundo', 'paras ka record',
  'that new patient from yesterday', 'the walk in from this morning',
  'my last patient', 'open the last patient again', 'previous patient record',
);

// ── Billing.patient (balance / due / final amount — keep corpus focused, not huge) ──
const bp = training['billing.patient'];
for (const p of PATIENTS) {
  const first = p.split(' ')[0];
  bp.push(
    `how much does ${first} owe`, `how much does patient ${first} owe`,
    `due amount for ${first}`, `due amount for patient ${first}`, `due amount for ${p}`,
    `what is ${first} final amount`, `what is patient ${first} final amount`,
    `patient ${first} balance due`, `balance due for ${first}`, `outstanding for ${p}`,
    `outstanding amount for ${first}`, `total bill for ${p}`, `total bill for ${first}`,
    `how much is ${first} due`, `how much is patient ${first} due`,
    `payment due for ${first}`, `pending bill for ${first}`, `amount due for ${p}`,
    `billing for patient ${first}`, `billing balance for ${first}`,
    `what does ${first} owe the clinic`, `final amount for patient ${p}`,
    `check due for ${first}`, `show outstanding for ${first}`,
  );
}
bp.push(
  'how much does this patient owe', 'what is the due amount', 'patient final amount',
  'check patient balance due', 'show outstanding for current patient',
  'how much is the bill', 'total due for this patient', 'billing balance please',
  'how much does patient paras owe', 'due amount for paras gupta',
  'what is paras final amount', 'outstanding amount for ravi sharma',
);

// ── Navigate (all app modules + clinical workflows) ──
const pages = [
  'schedule', 'todays schedule', 'appointment board', 'kanban', 'dashboard', 'booking',
  'new appointment', 'patients', 'patient directory', 'inventory', 'stock', 'consumables',
  'lab orders', 'labs', 'treatment plans', 'prescriptions', 'rx', 'prescription pad',
  'orthodontics', 'ortho cases', 'implantology', 'implant cases', 'endodontics', 'endo cases',
  'paedo cases', 'tmj cases', 'clinical session', 'billing', 'accounts', 'hr', 'staff page',
  'settings', 'release notes', 'feature flags', 'chairs', 'services catalog',
];
for (const p of pages) {
  training.navigate.push(`go to ${p}`, `open ${p}`, `show ${p}`, `take me to ${p}`, `switch to ${p}`);
}
training.navigate.push(
  // casual + hinglish
  'schedule kholo', 'booking kholo', 'inventory dikhao', 'patients ki list dikhao',
  'settings me jao', 'dashboard pe chalo', 'schedule dikha do', 'lab orders kholo',
  'lets see the schedule', 'bring up the schedule', 'i want to see the board',
  'back to dashboard', 'home page please', 'take me home', 'main screen',
  'where are my lab orders', 'wheres the inventory page', 'find the settings',
);

// ── Appointment booking (time-rich) ──
for (const proc of DENTAL_PROCEDURES) {
  for (const pat of ['ravi', 'paras', 'asha', 'priya']) {
    training['appointment.book'].push(
      `book ${proc} for ${pat}`, `schedule ${proc} for ${pat}`, `book ${proc} for ${pat} tomorrow`,
    );
  }
  for (const time of ['9am', '10am', '11am', '2pm', '3pm', '4pm', '5pm']) {
    training['appointment.book'].push(
      `book ${proc} at ${time}`, `schedule ${proc} at ${time} tomorrow`, `book ${proc} for ravi at ${time}`,
      `book ${proc} for paras at ${time} tomorrow`, `schedule ${proc} at ${time} today`,
    );
  }
}
training['appointment.book'].push(
  'book an appointment', 'schedule a checkup', 'book emergency slot today',
  'book ravi for cleaning at 10am tomorrow', 'schedule paras for rct at 3pm',
  'book asha for extraction at 11am', 'new appointment for priya at 4pm tomorrow',
  'book follow up for ravi next monday at 9am', 'schedule implant consult for amit at 2pm',
  'book ortho adjustment for neha at 5pm today', 'reserve chair 1 at 3pm for paras',
);

// ── Schedule summary (day-level) ──
training['schedule.summary'].push(
  'whats on today', 'how many patients today', 'todays appointments', 'how busy are we today',
  'any cancellations today', 'how many no shows today', 'who is my next patient',
  'who is next on the list', 'free slots today', 'are we fully booked today',
  'clinic load today', 'todays chair utilisation', 'daily appointment summary',
  'how many emergencies today', 'any walk ins today', 'patients remaining today',
  'morning load today', 'afternoon schedule count', 'evening appointments left',
  // casual real-world phrasings
  'whats on today friday', 'whats happening today', 'whats the plan today',
  'whats my day look like', 'hows my day looking', 'how does today look',
  'whats lined up today', 'whats on the board', 'run me through today',
  'walk me through my day', 'brief me on today', 'give me the rundown',
  'todays rundown please', 'how does the day look friday', 'busy day today',
  'is today busy', 'is it a heavy day', 'light day today', 'how full is today',
  'how packed are we', 'what have we got today', 'what do we have today',
  'anything today', 'do i have appointments today', 'my appointments today',
  'whos coming in today', 'who all is coming today', 'who do i see today',
  'patient count for the day', 'how many chairs running today',
  'wrap up of today', 'end of day summary', 'day summary friday',
  // other days (frontend fetches the date Friday extracts)
  'whats on tomorrow', 'whats on tomorrows schedule', 'tomorrows schedule',
  'tomorrows appointments', 'how many patients tomorrow', 'how busy is tomorrow',
  'is tomorrow busy', 'whats the plan tomorrow', 'tomorrows summary',
  'whats on monday', 'mondays schedule', 'how many patients on friday',
  'saturdays appointments', 'schedule for tomorrow', 'appointments for tomorrow',
  // hinglish
  'aaj kitne patients hain', 'aaj ka schedule kya hai', 'aaj kitna kaam hai',
  'aaj kaun kaun aa raha hai', 'aaj ka din kaisa hai', 'kitne appointments hain aaj',
  'kal kitne patients hain', 'kal ka schedule dikhao', 'kal kitna busy hai',
);

// ── Schedule.time (time-specific queries) ──
for (const time of TIMES) {
  for (const day of ['today', 'tomorrow', '']) {
    const d = day ? ` ${day}` : '';
    training['schedule.time'].push(
      `who is at ${time}${d}`, `appointments at ${time}${d}`, `what is at ${time}${d}`,
      `show schedule at ${time}${d}`, `patients at ${time}${d}`, `anything at ${time}${d}`,
      `free at ${time}${d}`, `is chair free at ${time}${d}`, `bookings at ${time}${d}`,
      `how many at ${time}${d}`, `whats happening at ${time}${d}`,
    );
  }
}
for (const day of DAYS) {
  training['schedule.time'].push(
    `${day} morning appointments`, `${day} afternoon schedule`, `${day} evening slots`,
    `first appointment ${day}`, `last appointment ${day}`, `schedule for ${day} at 10am`,
    `who do i see ${day} at 3pm`, `show ${day} 2pm slot`, `any gaps ${day} afternoon`,
  );
}
training['schedule.time'].push(
  'what about tomorrow', 'how about tomorrow', 'and tomorrow', 'what about monday',
  'how about 4pm', 'and the afternoon', 'what about the evening slot',
  'next available slot today', 'earliest free slot tomorrow', 'when is my next opening',
  'first free slot after lunch', 'slot before 5pm today', 'anything open at 4 today',
  'who is in chair 1 at 3pm', 'chair 2 at 10am today', 'schedule between 2 and 4 pm',
  'appointments from 9 to 12 today', 'how packed is 3pm today', 'running late at 11am',
);

// ── Agent.proactive (Friday-initiated / staff asks Friday to watch & notify) ──
const proactiveVerbs = [
  'remind me', 'notify me', 'alert me', 'tell me when', 'let me know when',
  'keep me posted on', 'keep me updated on', 'watch for', 'watch the', 'monitor',
  'update me on', 'ping me when', 'flag me when', 'heads up when',
];
const proactiveTopics = [
  'next patient', 'next appointment', 'schedule changes', 'cancellations', 'no shows',
  'delays', 'late patients', 'emergency walk in', 'lab delivery', 'inventory low stock',
  'paras arrival', 'patient check in', 'chair turnover', 'running behind schedule',
  'free slot opening', 'double booking', 'consent pending', 'payment pending',
];
for (const v of proactiveVerbs) {
  for (const t of proactiveTopics) {
    training['agent.proactive'].push(`${v} ${t}`, `friday ${v} ${t}`);
  }
}
training['agent.proactive'].push(
  'friday what should i do next', 'what should i do next friday', 'whats my next task',
  'friday suggest next action', 'friday guide me', 'help me prioritize today',
  'friday stay on top of schedule', 'keep watching the board friday',
  'friday proactive mode on', 'enable proactive alerts', 'turn on smart reminders',
  'friday tell me when paras is ready', 'alert me if anyone is waiting more than 15 minutes',
  'notify me when next patient checks in', 'friday watch chair 1 for me',
  'let me know if we fall behind', 'friday keep an eye on cancellations',
  'summarize changes every hour', 'friday brief me every 30 minutes',
  'what needs my attention right now', 'friday anything urgent',
  'friday prep me for next patient', 'tell me about my next case friday',
  'friday read out next patient details', 'auto update me on schedule shifts',
  'friday nudge me before each appointment', 'gentle reminder before next patient',
  'remind me when next patient checks in', 'notify me when next patient arrives',
);

// ── Behaviour (voice / assistant personality control) ──
training['behaviour'].push(
  // volume & pace
  'speak louder', 'speak softer', 'talk louder friday', 'talk quieter', 'lower your voice',
  'speak slower', 'talk slower friday', 'slow down', 'speak faster', 'speed up friday',
  'enunciate clearly', 'speak more clearly', 'stop mumbling friday',
  // output style
  'be brief', 'be concise', 'keep it short', 'give me more detail', 'be more detailed',
  'explain less', 'explain more', 'use simple words', 'use medical terms', 'be formal',
  'be casual', 'talk like a colleague', 'talk like reception', 'professional mode',
  // confirmation & control
  'confirm before acting', 'ask before you do anything', 'dont act without asking',
  'just do it without asking', 'stop asking for confirmation', 'auto mode on',
  'repeat that', 'say that again', 'repeat last command', 'what did you just say',
  'repeat slower', 'repeat louder',
  // listening mode
  'be quiet', 'stop talking', 'mute yourself', 'unmute', 'stop listening', 'start listening',
  'pause listening', 'resume listening', 'listen continuously', 'push to talk mode',
  'stop interrupting', 'wait for me to finish', 'dont cut me off',
  // language
  'speak hindi', 'speak english', 'use hinglish', 'switch to hindi', 'switch to english',
  'speak marathi', 'switch to marathi', 'marathi bol', 'marathi bola', 'marathi madhe bola',
  'hindi bolo', 'hindi me bolo', 'english bolo',
  // personality
  'be less sarcastic', 'be more sarcastic', 'more humor friday', 'less jokes friday',
  'be polite', 'be direct', 'no small talk', 'focus mode', 'reset personality',
  'default behaviour', 'normal mode friday',
  'workaholic mode', 'workaholic mode on', 'be a workaholic friday', 'all work no rest mode',
  'never stop working mode', 'grind mode friday', 'clinic addict mode',
);

// ── Smalltalk ──
training['smalltalk.greeting'].push(
  'hi friday', 'hello friday', 'good morning friday',
  'good afternoon friday', 'good evening friday', 'namaste friday',
  'wake up friday', 'ready friday', 'lets begin', 'morning friday',
  'good morning', 'good afternoon', 'good evening', 'morning team', 'afternoon friday',
  'evening friday', 'hi friday good morning', 'hello friday good afternoon',
);

const appExit = training['app.exit'];
appExit.push(
  'shutdown', 'shut down', 'shutdown friday', 'shut it down', 'power off',
  'switch off friday', 'band karo', 'app band karo', 'bandh karo friday',
  'logout', 'log out', 'logout from application', 'log out of the app', 'exit the app',
  'close the app', 'close the application', 'quit the app', 'leave the app',
  'log off', 'log off the app', 'logging off', 'logout friday', 'close friday',
  'exit friday', 'stop friday', 'friday log me out', 'friday logout',
  'fine just logout', 'ok fine logout', 'whatever logout', 'fine logout me',
  'just logout already', 'enough log me out', 'finally log me out', 'ugh logout',
  'logout already friday', 'im done log out', 'ok friday logout now',
  'get me out of the app', 'close this app', 'exit application please',
);
for (const line of [
  'leaving early', 'im leaving early', 'leave early today', 'going home early',
  'clocking out early', 'done early friday', 'half day today logout',
  'heading out early', 'leaving before five', 'calling it a day early',
  'sneaking out early friday', 'early exit close app', 'ducking out early',
  'fine im leaving early close app', 'whatever leaving early logout',
  'yeah yeah leaving early exit app', 'boss im out early close friday',
]) {
  appExit.push(line, `friday ${line}`, `${line} close the app`, `${line} log out`);
}

training['smalltalk.time'].push(
  'what time is it', 'tell me the time', 'current time', 'whats the time now',
  'what is the date today', 'todays date please', 'what day is it', 'tell me the date',
  'time in mumbai', 'clinic time now',
);

training['smalltalk.weather'].push(
  'how is the weather today', 'whats the weather like', 'what is the weather',
  'will it rain today', 'weather forecast', 'is it raining outside', 'humidity today',
);

// ── Sarcasm (dental + medical + chairside banter) ──
const sarcasmTemplates = [
  'are you a robot', 'are you human', 'are you ai',
  'do you love me', 'marry me friday', 'you are useless', 'shut up friday', 'you are dumb',
  'can you do a root canal on me', 'extract my wisdom tooth friday', 'drill my brain friday',
  'write me a prescription for laughing gas', 'diagnose my molar friday',
  'is amoxicillin good for a broken heart', 'do i need a crown or a tiara',
  'can you scale my karma', 'is my bite off or am i just ugly',
  'friday whats my pulp status', 'prescribe me braces for my personality',
  'can you cement my relationship', 'do a sinus lift on my mood friday',
  'is my gingiva inflamed or am i just angry', 'book me for an emergency ego extraction',
  'write an rx for confidence 500mg', 'is this periapical radiolucency or my aura',
  'friday am i a good candidate for implants', 'can you probe my soul depth',
  'do i need rct or just therapy', 'is metronidazole good for bad decisions',
  'friday debond my problems', 'adjust my occlusal plane of existence',
  'can you do a pulpotomy on my patience', 'is fluoride varnish good for my soul',
  'friday sign my consent form for life', 'give me a post and core for my spine',
  'is my open apex my personality type', 'friday obturate my feelings with gutta percha',
  'can you do ipr on my attitude', 'is my tmj clicking or am i just passive aggressive',
  'prescribe chlorhexidine for my toxic ex', 'friday apexify my career',
  'do i need a bone graft or a backbone', 'is this dry socket or dry personality',
  'friday whats the prognosis for my dating life', 'can you suture my broken heart',
  'is my overjet genetic or am i nosy', 'friday check my pulp with a cold test',
  'write augmentin for my commitment issues', 'can you extract my bad habits',
  'is my gingival recession emotional', 'friday do a flap surgery on my inbox',
  'prescribe dolo for existential pain', 'can you crown my ego in zirconia',
  'is my bite traumatic or am i', 'friday whats my plaque index on life choices',
  'do a opg on my future', 'is my cbct showing brain or just cavities',
  'friday am i endo curious or just curious', 'can you align my chakras with invisalign',
  'is pantoprazole for heartburn or heartbreak', 'friday impression my soul in alginate',
  'book me for nitrous oxide and nirvana', 'can you cure my caries and my character',
  'is my mobility grade 3 or am i flaky', 'friday debond me from this conversation',
  'give me a Michigan splint for my anxiety', 'can you graft bone into my bank account',
  'is my probing depth 6mm or am i deep', 'friday whats my caries risk score on love',
  'do i need a space maintainer for my sanity', 'prescribe eugenol for my soul ache',
  'can you do a frenectomy on my attachment issues', 'friday rate my smile 1 to 10',
  'is my occlusion stable or am i delusional', 'write a lab order for better life',
  'friday are you board certified in roasting', 'can you scale and polish my reputation',
];
training['smalltalk.sarcasm'].push(...sarcasmTemplates);

// Cross-pollinate patient.find with pharma/lab lookups (doctor asking while charting)
for (const drug of PHARMA_TERMS.slice(0, 10)) {
  pf.push(`show rx history with ${drug} for ravi`, `check if paras allergic to ${drug}`);
}
for (const lab of ['crown', 'bridge', 'denture', 'splint']) {
  pf.push(`show lab order for ${lab} of paras`, `check lab status for ravi ${lab}`);
}

training['smalltalk.thanks'].push(
  'thank you', 'thanks friday', 'thanks a lot', 'thank you so much', 'thanks', 'cheers',
  'much appreciated', 'good job friday', 'well done friday', 'perfect thanks',
);

training['smalltalk.bye'].push(
  'bye friday', 'goodbye', 'see you later', 'thats all for today', 'stop friday',
  'go offline', 'signing off', 'done for today', 'logging off',
);

// ── Identity (who/what are you) ──
training['smalltalk.identity'].push(
  'who are you', 'what are you', 'whats your name', 'what is your name',
  'introduce yourself', 'tell me about yourself', 'are you friday', 'who is friday',
  'who made you', 'who built you', 'are you an ai', 'are you a robot assistant',
  'are you jarvis', 'are you like jarvis', 'whats your purpose', 'why are you here',
  'what kind of assistant are you', 'are you a real assistant', 'what is friday',
  'describe yourself', 'who am i talking to',
);

// ── Help / capabilities (what can you do) ──
training['smalltalk.help'].push(
  'what can you do', 'what can you help with', 'how can you help', 'help me',
  'help', 'i need help', 'what commands can i use', 'show me commands',
  'list your commands', 'what should i say', 'what can i ask you', 'what can i ask',
  'how do i use you', 'give me examples', 'what are my options', 'guide me',
  'instructions please', 'what can i do here', 'what are you capable of',
  'what are your features', 'teach me how to use you', 'what do you know',
);

// ── How are you (interactive small talk) ──
training['smalltalk.howareyou'].push(
  'how are you', 'how are you doing', 'how are you today', 'how is it going',
  'hows it going', 'how do you feel', 'are you ok', 'are you okay', 'you good',
  'you doing ok', 'hows your day', 'how have you been', 'whats up friday',
  'sup friday', 'you doing alright', 'how are you friday', 'how you doing',
  'everything good friday', 'feeling good today',
);

// ── Jokes (real joke requests — separate from sarcasm/banter) ──
training['smalltalk.joke'].push(
  'tell me a joke', 'tell me a joke friday', 'another joke', 'one more joke',
  'make me laugh', 'crack a joke', 'joke please', 'say a joke', 'got any jokes',
  'know any jokes', 'tell me something funny', 'say something to cheer me up',
  'cheer me up friday', 'i need a laugh', 'lighten the mood', 'dental joke please',
  'tell a dentist joke', 'funny one friday', 'entertain me', 'ek joke sunao',
  'joke sunao friday', 'kuch funny bolo',
);

// ── Summon (bare wake word / presence check) ──
training['smalltalk.summon'].push(
  'friday', 'hey friday', 'yo friday', 'ok friday', 'okay friday', 'oi friday',
  'are you there', 'you there', 'friday are you there', 'you there friday',
  'friday you up', 'still there friday', 'can you hear me', 'friday can you hear me',
  'listening friday', 'friday listen', 'attention friday', 'friday sun',
  'suno friday', 'friday idhar', 'hello are you awake',
);

// ── Compliments (sarcastic-humble comebacks) ──
training['smalltalk.compliment'].push(
  'you are amazing', 'youre amazing', 'youre the best', 'you are the best',
  'i love you friday', 'youre brilliant', 'youre so smart', 'youre helpful',
  'youre awesome', 'you are awesome', 'i like you friday', 'youre a genius',
  'youre great', 'you are great friday', 'youre incredible', 'youre wonderful',
  'love working with you', 'youre fantastic', 'best assistant ever',
);

// Dedupe
for (const k of Object.keys(training)) {
  if (k.startsWith('_')) continue;
  training[k] = uniq(training[k]);
}

const out = path.join(__dirname, '..', 'data', 'friday-training.json');
fs.writeFileSync(out, JSON.stringify(training, null, 2) + '\n');

const counts = Object.entries(training)
  .filter(([k]) => !k.startsWith('_'))
  .map(([k, v]) => `${k}: ${v.length}`);
console.log('Wrote', out);
console.log(counts.join('\n'));
console.log('Total:', counts.reduce((s, c) => s + parseInt(c.split(': ')[1], 10), 0));
