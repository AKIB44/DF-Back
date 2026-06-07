// ────────────────────────────────────────────────────────────────────────────
// Clinical-data policies — PRD §5.3 catalog 8-10
// ────────────────────────────────────────────────────────────────────────────

const CLINICAL_ROLES = ['doctor', 'hygienist', 'assistant', 'manager', 'clinic_admin', 'org_admin', 'admin', 'super_admin'];

module.exports = [
  {
    name: 'clinical_note.read.reception_deny',
    version: 1,
    description: 'Reception cannot read clinical notes',
    effect: 'DENY',
    priority: 95,
    actions: ['read'],
    resourceTypes: ['clinical_note', 'examination', 'diagnosis', 'prescription', 'investigation', 'attachment'],
    condition: (ctx) => ctx.subject.role === 'reception',
  },
  {
    name: 'clinical_note.read.clinical_roles',
    version: 1,
    description: 'Clinical notes visible only to clinical staff',
    effect: 'PERMIT',
    priority: 60,
    actions: ['read'],
    resourceTypes: ['clinical_note', 'examination', 'diagnosis', 'prescription', 'investigation', 'attachment'],
    condition: (ctx) => CLINICAL_ROLES.includes(ctx.subject.role),
  },
  {
    name: 'clinical_note.addendum.post_seal',
    version: 1,
    description: 'Clinical roles can append addenda after seal',
    effect: 'PERMIT',
    priority: 70,
    actions: ['create'],
    resourceTypes: ['clinical_note'],
    condition: (ctx) =>
      ['doctor', 'hygienist'].includes(ctx.subject.role) &&
      ctx.resource.extras?.is_addendum === true,
  },
  {
    name: 'clinical_resource.update.unsealed_clinical_roles',
    version: 1,
    description: 'Clinical roles update clinical child resources while the session is unsealed',
    effect: 'PERMIT',
    priority: 60,
    actions: ['create', 'update', 'delete'],
    resourceTypes: ['examination', 'diagnosis', 'investigation', 'attachment'],
    condition: (ctx) =>
      CLINICAL_ROLES.includes(ctx.subject.role) &&
      ctx.resource.status !== 'COMPLETED' &&
      ctx.resource.status !== 'completed' &&
      !ctx.resource.sealedAt,
  },
  {
    name: 'patient.read.clinical_roles',
    version: 1,
    description: 'Clinical staff read patient records',
    effect: 'PERMIT',
    priority: 60,
    actions: ['read'],
    resourceTypes: ['patient'],
    condition: (ctx) => CLINICAL_ROLES.includes(ctx.subject.role),
  },
  {
    name: 'patient.read.reception_demographics',
    version: 1,
    description: 'Reception sees patient demographics for scheduling',
    effect: 'PERMIT',
    priority: 50,
    actions: ['read'],
    resourceTypes: ['patient'],
    condition: (ctx) => ctx.subject.role === 'reception',
  },
  {
    name: 'patient.update.clinical_or_reception',
    version: 1,
    description: 'Patients are editable by clinical staff and reception',
    effect: 'PERMIT',
    priority: 60,
    actions: ['create', 'update'],
    resourceTypes: ['patient'],
    condition: (ctx) =>
      ['doctor','hygienist','assistant','reception','manager','clinic_admin','org_admin','admin','super_admin']
        .includes(ctx.subject.role),
  },
];
