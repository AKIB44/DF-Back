// ────────────────────────────────────────────────────────────────────────────
// Policy catalog index — registers every policy with the engine at boot.
// ────────────────────────────────────────────────────────────────────────────
//
// Add a new policy file? Require it here and pass its export to engine.registerAll.
// Convention: one file per resource family; each file default-exports an array.
// ────────────────────────────────────────────────────────────────────────────

const { engine } = require('../engine/policy-engine');

let registered = false;

function registerAllPolicies() {
  if (registered) return;
  registered = true;

  const sessionPolicies   = require('./session.policies');
  const clinicalPolicies  = require('./clinical.policies');
  const billingPolicies   = require('./billing.policies');
  const servicePolicies   = require('./service.policies');
  const treatmentPolicies = require('./treatment-plan.policies');
  const specialtyPolicies = require('./specialty.policies');
  const inventoryPolicies = require('./inventory.policies');
  const adminPolicies     = require('./admin.policies');

  engine.registerAll([
    ...sessionPolicies, ...clinicalPolicies, ...billingPolicies, ...servicePolicies,
    ...treatmentPolicies, ...specialtyPolicies, ...inventoryPolicies, ...adminPolicies,
  ]);

  console.log(`[abac] registered ${engine.list().length} policies`);
}

module.exports = { registerAllPolicies };
