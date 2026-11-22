// SafeFast Rx — HL7 CDS Hooks service (patient-view + order-select)
// Runs as a Cloudflare Worker (free). Demo rules only: pending clinical pharmacist review.
const APP = 'https://safe-fast.github.io/safe-fast/doctor.html';
const RAMADAN_START = Date.UTC(2027, 1, 8); // 1 Ramadan 1448 (Umm al-Qura, expected)
const WINDOW_DAYS = 90;
const SOURCE = { label: 'SafeFast Rx (demo rules: IDF-DAR 2021, Heart 2022; pending clinical pharmacist review)', url: 'https://safe-fast.github.io/safe-fast/' };

// cls: drug class; t: suggested Ramadan timing; dec: doctor must decide the dose; crit: critical (never skip/double)
const RULES = [
  { re: /insulin\s*(glargine|detemir|degludec)|lantus|levemir|tresiba|toujeo|basal|nph|isophane/i, cls: 'Basal insulin', t: 'With iftar, dose reduced 15 to 30% (doctor sets the dose)', dec: true },
  { re: /insulin|novorapid|humalog|aspart|lispro|glulisine/i, cls: 'Mealtime insulin', t: 'Usual dose at iftar, suhoor dose reduced 25 to 50%, no midday dose', dec: true },
  { re: /glibenclamide|glyburide|glipizide|gliclazide|glimepiride/i, cls: 'Sulfonylurea', t: 'Move to iftar; consider dose reduction (avoid glibenclamide)', dec: true },
  { re: /empagliflozin|dapagliflozin|canagliflozin|ertugliflozin|jardiance|forxiga/i, cls: 'SGLT2 inhibitor', t: 'With iftar; consider pausing if elderly, on a diuretic or with weak kidneys' },
  { re: /metformin/i, cls: 'Metformin', t: 'Once daily: with iftar. Twice daily: iftar and suhoor' },
  { re: /warfarin|coumadin/i, cls: 'Warfarin', t: 'Once daily with iftar; INR in week 1 or 2 of Ramadan', crit: true },
  { re: /apixaban|eliquis|dabigatran|pradaxa/i, cls: 'DOAC twice daily', t: 'Two doses: suhoor and iftar. Never switch to once daily without the doctor', crit: true },
  { re: /rivaroxaban|xarelto|edoxaban/i, cls: 'DOAC once daily', t: 'Once daily with iftar (absorbed with food)', crit: true },
  { re: /furosemide|bumetanide|torsemide|hydrochlorothiazide|chlorthalidone|indapamide|spironolactone/i, cls: 'Diuretic', t: 'After iftar, not at suhoor (daytime dehydration)' },
  { re: /atorvastatin|rosuvastatin/i, cls: 'Statin (long-acting)', t: 'With iftar' },
  { re: /simvastatin|pravastatin|lovastatin/i, cls: 'Statin (short-acting)', t: 'Evening after Taraweeh' },
  { re: /lisinopril|enalapril|ramipril|losartan|valsartan|amlodipine|bisoprolol|metoprolol|carvedilol|atenolol/i, cls: 'Antihypertensive', t: 'Once daily with iftar (check BP and kidney function before Ramadan)' },
  { re: /levothyroxine|synthroid|eltroxin/i, cls: 'Thyroid hormone', t: 'Empty stomach 30 min before suhoor, 4 h apart from calcium/iron', crit: false },
  { re: /omeprazole|esomeprazole|pantoprazole|lansoprazole/i, cls: 'PPI', t: '30 min before suhoor' },
  { re: /levetiracetam|valproate|carbamazepine|lamotrigine|phenytoin/i, cls: 'Antiepileptic', t: 'Same daily dose split between suhoor and iftar', crit: true },
  { re: /aspirin|clopidogrel|ticagrelor|prasugrel/i, cls: 'Antiplatelet', t: 'With iftar' },
  { re: /ibuprofen|naproxen|diclofenac|meloxicam/i, cls: 'NSAID', t: 'Avoid while fasting; paracetamol is safer' },
];

const PAIRS = [
  { a: /Warfarin|DOAC/, b: /NSAID|Antiplatelet/, ind: 'critical', s: 'Anticoagulant with NSAID/antiplatelet: bleeding risk', d: 'Confirm the combination is intended and time-limited.' },
  { a: /SGLT2/, b: /Diuretic/, ind: 'warning', s: 'SGLT2 inhibitor with a diuretic: dehydration risk while fasting', d: 'Review the diuretic dose or pause the SGLT2 inhibitor during Ramadan.' },
  { a: /Sulfonylurea/, b: /insulin/i, ind: 'warning', s: 'Insulin with a sulfonylurea: high hypoglycemia risk while fasting', d: 'Both need a dose decision before Ramadan.' },
  { a: /Sulfonylurea|insulin/i, b: /Antihypertensive/, only: /bisoprolol|metoprolol|carvedilol|atenolol/i, ind: 'warning', s: 'Beta-blocker may mask hypoglycemia symptoms while fasting', d: 'Teach the patient that sweating and hunger may be the only signs, and to check glucose whenever in doubt.' },
  { a: /Thyroid/, b: /PPI/, ind: 'info', s: 'Levothyroxine and PPI both at suhoor', d: 'Keep levothyroxine first, on an empty stomach.' },
];

const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', ...CORS } });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, Accept' };

const SERVICES = [
  {
    hook: 'patient-view', id: 'safefast-ramadan', title: 'SafeFast Rx: pre-Ramadan medication plan',
    description: 'Within 90 days before Ramadan, shows which active medicines need a new fasting schedule or a doctor decision.',
    prefetch: { patient: 'Patient/{{context.patientId}}', meds: 'MedicationRequest?patient={{context.patientId}}&status=active' },
  },
  {
    hook: 'order-select', id: 'safefast-new-drug', title: 'SafeFast Rx: new drug during the Ramadan window',
    description: 'Checks a newly selected medicine against fasting timing and the patient’s active medicines.',
    prefetch: { meds: 'MedicationRequest?patient={{context.patientId}}&status=active' },
  },
];

function medName(r) {
  const c = r && (r.medicationCodeableConcept || (r.medication && r.medication.concept));
  if (!c) return r && r.medicationReference && r.medicationReference.display || null;
  return c.text || (c.coding && c.coding[0] && c.coding[0].display) || null;
}
function classify(name) { for (const r of RULES) if (r.re.test(name)) return { name, ...r }; return { name, cls: null }; }
function entries(b) { return b && b.resourceType === 'Bundle' ? (b.entry || []).map(e => e.resource).filter(x => x && x.resourceType === 'MedicationRequest') : []; }

async function fhirGet(req, path) {
  if (!req.fhirServer) return null;
  const h = { accept: 'application/fhir+json' };
  if (req.fhirAuthorization && req.fhirAuthorization.access_token) h.authorization = 'Bearer ' + req.fhirAuthorization.access_token;
  try { const r = await fetch(req.fhirServer.replace(/\/$/, '') + '/' + path, { headers: h }); return r.ok ? r.json() : null; } catch { return null; }
}

function daysToRamadan(now = Date.now()) { return Math.ceil((RAMADAN_START - now) / 864e5); }

function interactionCards(list) {
  const out = [], seen = new Set();
  for (const p of PAIRS) {
    const A = list.find(m => m.cls && p.a.test(m.cls)), B = list.find(m => m.cls && p.b.test(m.cls) && m !== A && (!p.only || p.only.test(m.name)));
    if (A && B && !seen.has(p.s)) { seen.add(p.s); out.push({ summary: p.s, indicator: p.ind, detail: `**${A.name}** + **${B.name}**. ${p.d}`, source: SOURCE }); }
  }
  return out;
}

function patientView(req, meds, patient, now) {
  const days = daysToRamadan(now);
  if (days > WINDOW_DAYS || days < -30) return { cards: [] };
  const list = meds.map(medName).filter(Boolean).map(classify);
  if (!list.length) return { cards: [] };
  const known = list.filter(m => m.cls), dec = known.filter(m => m.dec), unknown = list.filter(m => !m.cls);
  const who = patient && patient.name && patient.name[0] ? [(patient.name[0].given || []).join(' '), patient.name[0].family].filter(Boolean).join(' ') : 'this patient';
  const rows = known.map(m => `| ${m.name} | ${m.t}${m.crit ? ' **(critical: never skip or double)**' : ''} | ${m.dec ? 'Yes' : ''} |`).join('\n');
  const when = days > 0 ? `Ramadan starts in ${days} days (expected 8 Feb 2027)` : 'Ramadan has started';
  const cards = [{
    uuid: 'safefast-summary',
    summary: `SafeFast: ${known.length} of ${list.length} medicines need a Ramadan schedule${dec.length ? `, ${dec.length} need${dec.length === 1 ? 's' : ''} your dose decision` : ''}`.slice(0, 140),
    indicator: dec.length ? 'warning' : 'info',
    detail: `${when}. Suggested fasting schedule for ${who}:\n\n| Medicine | Suggested Ramadan timing | Doctor decision |\n|---|---|---|\n${rows}` +
      (unknown.length ? `\n\nNot in the rule library (refer to the doctor): ${unknown.map(m => m.name).join(', ')}.` : '') +
      `\n\nThe doctor approves every line in SafeFast; nothing reaches the patient before that.`,
    source: SOURCE,
    links: [{ label: 'Build the Ramadan plan in SafeFast', url: APP, type: 'absolute' }],
  }];
  return { cards: cards.concat(interactionCards(known)) };
}

function orderSelect(req, meds, now) {
  const days = daysToRamadan(now);
  if (days > WINDOW_DAYS || days < -30) return { cards: [] };
  const drafts = entries(req.context && req.context.draftOrders);
  const sel = new Set(req.context && req.context.selections || []);
  const chosen = drafts.filter(d => !sel.size || sel.has('MedicationRequest/' + d.id)).map(medName).filter(Boolean).map(classify);
  const active = meds.map(medName).filter(Boolean).map(classify);
  const cards = [];
  for (const n of chosen) {
    const freq = /tid|three times|3 times|q8h/i.test(JSON.stringify(drafts));
    if (!n.cls) cards.push({ summary: `SafeFast: ${n.name} has no Ramadan rule yet`, indicator: 'info', detail: 'Not in the rule library, so it is referred to the doctor for timing during fasting.', source: SOURCE });
    else cards.push({ summary: `SafeFast: ${n.name} in Ramadan: ${n.t}`.slice(0, 140), indicator: n.dec || n.cls === 'NSAID' ? 'warning' : 'info', detail: `${days > 0 ? `Ramadan starts in ${days} days.` : 'Ramadan has started.'} ${n.t}.${freq ? ' Three daily doses do not fit the fasting window: consider a once or twice daily alternative.' : ''}`, source: SOURCE });
    cards.push(...interactionCards([n, ...active.filter(a => a.cls)]).filter(c => c.detail.includes(n.name)));
  }
  return { cards };
}

export async function handle(request, now = Date.now()) {
  const url = new URL(request.url), p = url.pathname.replace(/\/+$/, '');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method === 'GET' && (p === '' || p === '/cds-services')) return json({ services: SERVICES });
  const m = p.match(/^\/cds-services\/([\w-]+)(\/feedback)?$/);
  if (!m || request.method !== 'POST') return json({ error: 'not found' }, 404);
  if (m[2]) return json({});
  let req; try { req = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const pre = req.prefetch || {}, pid = req.context && req.context.patientId;
  const medsB = pre.meds || (pid ? await fhirGet(req, `MedicationRequest?patient=${pid}&status=active`) : null);
  const meds = entries(medsB);
  if (m[1] === 'safefast-ramadan') {
    const patient = pre.patient || (pid ? await fhirGet(req, 'Patient/' + pid) : null);
    return json(patientView(req, meds, patient, now));
  }
  if (m[1] === 'safefast-new-drug') return json(orderSelect(req, meds, now));
  return json({ error: 'unknown service' }, 404);
}

export default { fetch: (request) => handle(request) };
