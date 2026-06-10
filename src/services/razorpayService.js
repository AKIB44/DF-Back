'use strict';

// Razorpay integration boundary.
//
// AC-1 ships this as a STUB: no SDK, no network. When RAZORPAY_KEY_ID is absent
// (the current state), every call returns a deterministic mock id and never
// throws, so plan management and later flows work end-to-end without external
// credentials. The real SDK wiring (recurring billing, webhooks) lands in a
// later phase — only this file changes when it does.

const crypto = require('crypto');

function isLive() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function mockId(prefix, seed) {
  const suffix = crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 14);
  return `${prefix}_stub_${suffix}`;
}

// ── Plans ─────────────────────────────────────────────────────────────────────

/** Create a Razorpay Plan for a subscription_plan row. Returns { razorpay_plan_id }. */
async function createPlan(plan) {
  if (!isLive()) {
    return { razorpay_plan_id: mockId('plan', plan.slug || plan.id) };
  }
  // TODO(real): const rp = getClient(); const created = await rp.plans.create({...}); return { razorpay_plan_id: created.id };
  throw new Error('razorpayService.createPlan: live mode not yet implemented');
}

/** Plans are immutable in Razorpay; "update" creates a new versioned plan. Stub mirrors createPlan. */
async function updatePlan(plan) {
  if (!isLive()) {
    return { razorpay_plan_id: plan.razorpay_plan_id || mockId('plan', `${plan.slug}-${Date.now()}`) };
  }
  throw new Error('razorpayService.updatePlan: live mode not yet implemented');
}

// ── Subscriptions (used by later phases) ───────────────────────────────────────

async function createSubscription({ planRazorpayId, tenantId }) {
  if (!isLive()) return { razorpay_subscription_id: mockId('sub', `${planRazorpayId}-${tenantId}`) };
  throw new Error('razorpayService.createSubscription: live mode not yet implemented');
}

async function cancelSubscription(razorpaySubscriptionId) {
  if (!isLive()) return { id: razorpaySubscriptionId, status: 'cancelled' };
  throw new Error('razorpayService.cancelSubscription: live mode not yet implemented');
}

/** Verify a webhook payload signature. Stub returns false when no secret is configured. */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
  } catch {
    return false;
  }
}

module.exports = {
  isLive,
  createPlan,
  updatePlan,
  createSubscription,
  cancelSubscription,
  verifyWebhookSignature,
};
