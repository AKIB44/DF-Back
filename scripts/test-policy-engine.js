#!/usr/bin/env node
// Smoke test for the policy engine + PR2 policies. Run without spinning up the
// server: `node scripts/test-policy-engine.js`.

const { engine }              = require('../src/security/engine/policy-engine');
const { registerAllPolicies } = require('../src/security/policies');

registerAllPolicies();

function ctx({ role='doctor', subjectId='u1',
               ownerId=null, status=null, sealedAt=null, branchId='b1',
               resourceType='session', action='read' } = {}) {
  return {
    subject: { id: subjectId, role, specialtyTags: [], branchId, hierarchyLevel: 60 },
    resource: { type: resourceType, id: 'r1', ownerId, status, branchId, sealedAt, extras: {} },
    action,
    environment: { now: new Date(), ipAddress: '', userAgent: '', requestId: '' },
  };
}

const cases = [
  // session.read.own
  ['doctor reads own session',      ctx({ role:'doctor', subjectId:'u1', ownerId:'u1' }), 'PERMIT', 'session.read.own'],
  ['doctor cannot read other dr',   ctx({ role:'doctor', subjectId:'u1', ownerId:'u2' }), 'DENY', 'default_deny'],

  // session.read.same_branch
  ['manager reads branch session',  ctx({ role:'manager', branchId:'b1' }), 'PERMIT', 'session.read.same_branch'],

  // session.update.sealed_deny
  ['sealed session update denied',  ctx({ role:'doctor', subjectId:'u1', ownerId:'u1', status:'COMPLETED', sealedAt:new Date(), action:'update' }), 'DENY', 'session.update.sealed_deny'],
  ['unsealed own session update OK',ctx({ role:'doctor', subjectId:'u1', ownerId:'u1', status:'IN_PROGRESS', action:'update' }), 'PERMIT', 'session.update.own_unsealed'],

  // clinical_note reception deny
  ['reception denied clinical note',ctx({ role:'reception', resourceType:'clinical_note', action:'read' }), 'DENY', 'clinical_note.read.reception_deny'],
  ['hygienist reads clinical note', ctx({ role:'hygienist', resourceType:'clinical_note', action:'read' }), 'PERMIT', 'clinical_note.read.clinical_roles'],

  // PR3 — billing
  ['assistant denied charge_line',  ctx({ role:'assistant', resourceType:'charge_line', action:'read' }), 'DENY',  'charge_line.read.assistant_deny'],
  ['reception reads charge_line',   ctx({ role:'reception', resourceType:'charge_line', action:'read' }), 'PERMIT','charge_line.read.billing_roles'],
  ['hard-cap discount denied',      { ...ctx({ role:'manager', action:'approve_discount', resourceType:'charge_line' }), resource:{type:'charge_line', extras:{discount_pct:40, discount_hard_cap:30}} }, 'DENY', 'discount.deny.above_hard_cap'],

  // PR3 — specialty
  ['doctor reads own specialty',    ctx({ role:'doctor', subjectId:'u1', ownerId:'u1', resourceType:'specialty_case' }), 'PERMIT', 'specialty_case.read.own_specialty'],
  ['manager reads any specialty',   ctx({ role:'manager', resourceType:'specialty_case', branchId:'b1' }), 'PERMIT', 'specialty_case.read.managerial'],

  // PR3 — inventory
  ['assistant reads inventory',     ctx({ role:'assistant', resourceType:'inventory_item', action:'read' }), 'PERMIT', 'inventory.read.all_clinical'],
  ['reception cannot adjust stock', ctx({ role:'reception', resourceType:'stock_movement', action:'create' }), 'DENY', 'default_deny'],

  // PR3 — admin / audit
  ['manager reads audit log',       ctx({ role:'manager', resourceType:'audit_log', action:'read' }), 'PERMIT', 'audit_log.read.admin_only'],
  ['reception denied audit log',    ctx({ role:'reception', resourceType:'audit_log', action:'read' }), 'DENY', 'default_deny'],
  ['doctor creates prescription',   ctx({ role:'doctor', resourceType:'prescription', action:'create' }), 'PERMIT', 'prescription.create.doctor_only'],
];

let pass = 0;
for (const [label, c, wantDecision, wantPolicy] of cases) {
  const r = engine.evaluate(c);
  const ok = r.decision === wantDecision && (!wantPolicy || r.policy === wantPolicy);
  if (ok) pass++;
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${label.padEnd(38)} → ${r.decision} via ${r.policy}`);
  if (!ok) console.log(`     expected ${wantDecision}${wantPolicy ? ' / ' + wantPolicy : ''}`);
}
console.log(`\n${pass}/${cases.length} passing`);
process.exit(pass === cases.length ? 0 : 1);
