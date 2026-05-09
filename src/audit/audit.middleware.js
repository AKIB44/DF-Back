const auditService = require('./audit.service');

module.exports = (req, res, next) => {
  req.audit = {
    write: (evt) => auditService.write({
      org_id:    req.context?.orgId,
      clinic_id: req.context?.clinicId,
      actor_type: req.context?.actorType || 'system',
      actor_id:   req.context?.userId,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      ...evt,
    }),
  };
  next();
};
