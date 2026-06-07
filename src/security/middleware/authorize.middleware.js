// ────────────────────────────────────────────────────────────────────────────
// authorize(action, resourceType) — the single ABAC integration point
// ────────────────────────────────────────────────────────────────────────────
//
// Usage (mounts AFTER `authenticate` + `loadResource`):
//
//   router.get(
//     '/sessions/:id',
//     authenticate,
//     loadResource('session', 'id'),
//     authorize('read', 'session'),
//     sessionController.getById
//   );
//
// The middleware builds a PolicyContext, asks the engine, audits, and either
// `next()`s the request or returns a typed 403. Existing-route rollouts can
// use observe/warn modes to log decisions without blocking current behavior.
// ────────────────────────────────────────────────────────────────────────────

const { engine } = require('../engine/policy-engine');
const { recordDecision } = require('./audit-decision.middleware');
const { buildSubject } = require('../helpers/build-subject');

function authorize(action, resourceType, options = {}) {
  const mode = options.mode || 'enforce';
  return async function authorizeMw(req, res, next) {
    try {
      const subject = await buildSubject(req);
      const resource = req.resource && req.resource.type === resourceType
        ? req.resource
        : { type: resourceType };

      const ctx = {
        subject,
        resource,
        action,
        environment: {
          now: new Date(),
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] || '',
          requestId: req.id || req.headers['x-request-id'] || '',
        },
      };

      const result = engine.evaluate(ctx);
      req.abacDecision = result;

      // Fire-and-forget audit — never blocks the request.
      recordDecision(ctx, result).catch(err =>
        console.warn('[authorize] audit write failed:', err.message)
      );

      if (result.decision === 'PERMIT') return next();
      if (mode === 'observe' || mode === 'warn') {
        if (mode === 'warn') {
          res.setHeader('X-ABAC-Warning', `${result.policy}: ${result.reason || 'DENY'}`);
        }
        return next();
      }

      return res.status(403).json({
        error: 'ACCESS_DENIED',
        message: result.reason || 'Insufficient permissions.',
        policy: result.policy,
      });
    } catch (err) { next(err); }
  };
}

module.exports = { authorize };
