module.exports = (req, res, next) => {
  const auth = req.user;
  if (!auth) return res.status(401).json({ error: 'unauthorized' });

  const clinicId = auth.active_clinic_id || auth.clinic_id;
  if (!clinicId && auth.type !== 'platform_admin') {
    return res.status(400).json({ error: 'no_active_clinic' });
  }

  req.context = {
    orgId:     auth.org_id,
    clinicId,
    userId:    auth.sub,
    actorType: auth.type || 'user',
  };

  // Keep backward compat for routes still reading req.user.clinic_id
  req.user.clinic_id = clinicId;

  next();
};
