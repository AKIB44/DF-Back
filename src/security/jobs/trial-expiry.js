// ────────────────────────────────────────────────────────────────────────────
// Trial-expiry enforcer (AC-2). Daily: any clinic still on TRIAL past its
// trial_ends_at is suspended (drops to read-only via tenant-scope middleware),
// its TRIALING subscription is marked EXPIRED, and the transition is logged.
//   require('./security/jobs/trial-expiry').start();
// ────────────────────────────────────────────────────────────────────────────

const db = require('../../db');
const tenantScope = require('../../rbac/tenant-scope.middleware');

const TICK_MS = 24 * 60 * 60 * 1000;

let timer = null;

async function sweep() {
  try {
    const { rows } = await db.query(
      `UPDATE clinics
          SET tenant_status = 'SUSPENDED', suspended_at = now()
        WHERE tenant_status = 'TRIAL' AND trial_ends_at < now()
        RETURNING id`
    );
    if (!rows.length) return;

    const ids = rows.map((r) => r.id);
    await db.query(
      `UPDATE subscription SET status = 'EXPIRED', updated_at = now()
        WHERE tenant_id = ANY($1::uuid[]) AND status = 'TRIALING' AND deleted_at IS NULL`,
      [ids]
    );
    await db.query(
      `INSERT INTO tenant_access_log (tenant_id, action, from_status, to_status, metadata)
       SELECT unnest($1::uuid[]), 'SUSPENDED', 'TRIAL', 'SUSPENDED', '{"reason":"trial_expired"}'::jsonb`,
      [ids]
    );
    // Drop cached statuses so the read-only gate sees the change immediately.
    ids.forEach((id) => tenantScope.invalidateTenantStatus(id));
    console.log(`[trial] suspended ${ids.length} clinic(s) with expired trials`);
  } catch (err) {
    console.warn('[trial] expiry sweep failed:', err.message);
  }
}

function start() {
  if (timer) return;
  setTimeout(sweep, 30_000).unref?.();
  timer = setInterval(sweep, TICK_MS);
  timer.unref?.();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, _sweep: sweep };
