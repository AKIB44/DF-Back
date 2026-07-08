// ── Friday — Clinic Voice Assistant ────────────────────────────────────────
//
// POST /v1/assistant/interpret
//   body: { transcript, patient_id?, refresh_token? }
//
// app.exit: revokes refresh session + action.logout → frontend clears auth & /login
// billing.patient: DB patient search + billing summary
// ────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const db           = require('../db');
const authenticate = require('../middleware/authenticate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');
const { classify, getTimeContext } = require('../ai/friday-nlu');
const {
  greetingMessage,
  workaholicMessage,
  userContextFromReq,
  resolveGreetingAddressee,
} = require('../ai/friday-time');
const { resolveBillingForPatient } = require('../ai/friday-billing');
const { performAppLogout } = require('../ai/friday-app-exit');

const router = express.Router();
router.use(authenticate, tenantScope);

router.use(async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT enabled FROM feature_flags
         WHERE org_id = $1 AND flag_key = 'voice_assistant.friday'`,
      [req.user.org_id]
    );
    if (!r.rows.length || r.rows[0].enabled !== true) {
      return res.status(403).json({ error: 'Friday is disabled for this organization.' });
    }
    next();
  } catch (err) { next(err); }
});

router.post('/interpret', requirePermission(P.PATIENT_VIEW), async (req, res, next) => {
  try {
    const transcript = (req.body?.transcript || '').toString().trim();
    if (!transcript) return res.status(400).json({ error: 'transcript is required' });

    const patientId    = (req.body?.patient_id || req.body?.context?.patient_id || '').toString().trim() || null;
    const refreshToken = (req.body?.refresh_token || '').toString().trim() || null;

    let result = classify(transcript, req.user.sub);
    if (!result.time_context) {
      result = { ...result, time_context: getTimeContext() };
    }

    const userCtx = userContextFromReq(req.user);
    // Personalise every reply: {addressee} → first name / "Dr. X" / "Doctor".
    const replyAddressee = resolveGreetingAddressee(userCtx);
    if (result.message && result.message.includes('{addressee}')) {
      result = { ...result, message: result.message.replace(/\{addressee\}/g, replyAddressee) };
    }
    if (result.intent === 'smalltalk.greeting') {
      const addressee = resolveGreetingAddressee(userCtx);
      result = {
        ...result,
        message:  greetingMessage(transcript, result.time_context, userCtx),
        entities: { ...result.entities, addressee, period: result.time_context.period },
        user:     userCtx,
      };
    }
    if (result.intent === 'behaviour' && result.entities?.action === 'workaholic_mode') {
      result = {
        ...result,
        message: workaholicMessage(result.time_context, userCtx),
      };
    }

    if (result.intent === 'app.exit' || result.intent === 'account.sign_out') {
      const logout = await performAppLogout(req.user.sub, refreshToken);
      return res.json({
        ...result,
        transcript,
        logout,
        action: result.action || {
          type:             'logout',
          redirect:         '/login',
          revoke_session:   true,
          clear_local_auth: true,
        },
      });
    }

    if (result.intent === 'billing.patient') {
      const resolved = await resolveBillingForPatient(req.user.clinic_id, {
        patient_id: patientId || undefined,
        query:      result.entities?.query || undefined,
        aspect:     result.entities?.aspect || 'due',
      });

      return res.json({
        ...result,
        transcript,
        status:     resolved.status,
        source:     resolved.source || null,
        patient:    resolved.patient || null,
        billing:    resolved.billing || null,
        candidates: resolved.candidates || null,
        action:     resolved.action || null,
        message:    resolved.message || result.message,
      });
    }

    res.json({ ...result, transcript });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
