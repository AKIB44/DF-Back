// ────────────────────────────────────────────────────────────────────────────
// Policy engine — lightweight, in-process, deny-by-default.
// ────────────────────────────────────────────────────────────────────────────
//
//   const { engine } = require('./security/engine/policy-engine');
//   engine.register(myPolicy);
//   const result = engine.evaluate(ctx);
//   // → { decision: 'PERMIT' | 'DENY', policy, reason? }
//
// Evaluation rules:
//
//  1. Pre-filter policies to those whose `actions` and `resourceTypes` match.
//  2. Walk in descending priority order. First matching policy's effect wins
//     (DENY beats lower-priority PERMIT because it was placed first).
//  3. Otherwise → DENY (deny-by-default).
// ────────────────────────────────────────────────────────────────────────────

class PolicyEngine {
  constructor() {
    /** @type {import('./types').Policy[]} */
    this._policies = [];
    this._byName = new Map();
  }

  /** @param {import('./types').Policy} policy */
  register(policy) {
    if (!policy || !policy.name) throw new Error('Policy must have a name');
    if (this._byName.has(policy.name)) {
      throw new Error(`Duplicate policy name: ${policy.name}`);
    }
    if (typeof policy.condition !== 'function') {
      throw new Error(`Policy ${policy.name} missing condition()`);
    }
    this._policies.push(policy);
    this._byName.set(policy.name, policy);
    // Keep sorted so evaluate() can walk in priority order.
    this._policies.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /** Bulk register — convenience for policy-catalog index file. */
  registerAll(policies) {
    for (const p of policies) this.register(p);
  }

  list() { return [...this._policies]; }
  get(name) { return this._byName.get(name); }

  /**
   * @param {import('./types').PolicyContext} ctx
   * @returns {import('./types').DecisionResult}
   */
  evaluate(ctx) {
    if (!ctx || !ctx.subject || !ctx.resource || !ctx.action) {
      return { decision: 'DENY', policy: 'default_deny', reason: 'malformed context' };
    }

    const applicable = this._policies.filter(p =>
      p.actions.includes(ctx.action) &&
      p.resourceTypes.includes(ctx.resource.type)
    );

    if (applicable.length === 0) {
      return { decision: 'DENY', policy: 'default_deny', reason: 'No applicable policy' };
    }

    for (const policy of applicable) {
      let matched = false;
      try {
        matched = policy.condition(ctx) === true;
      } catch (err) {
        console.error(`[policy-engine] ${policy.name} threw:`, err.message);
        // A throwing policy is treated as a no-match; do not crash the request.
        continue;
      }
      if (matched) {
        if (policy.effect === 'DENY') {
          return {
            decision: 'DENY',
            policy: policy.name,
            policyVersion: policy.version,
            reason: policy.description,
          };
        }
        return {
          decision: 'PERMIT',
          policy: policy.name,
          policyVersion: policy.version,
        };
      }
    }

    return { decision: 'DENY', policy: 'default_deny', reason: 'No matching policy condition' };
  }
}

const engine = new PolicyEngine();

module.exports = { engine, PolicyEngine };
