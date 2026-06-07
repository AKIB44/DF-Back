// ────────────────────────────────────────────────────────────────────────────
// Specialty-case policies — PRD §5.3 catalog 15-16
// ────────────────────────────────────────────────────────────────────────────

module.exports = [
  {
    name: 'specialty_case.read.own_specialty',
    version: 1,
    description: 'Doctor reads cases they own or that match a specialty tag',
    effect: 'PERMIT',
    priority: 60,
    actions: ['read'],
    resourceTypes: ['specialty_case','specialty_visit'],
    condition: (ctx) => {
      if (ctx.subject.role !== 'doctor') return false;
      if (ctx.resource.ownerId === ctx.subject.id) return true;
      const tag = (ctx.resource.specialtyCaseType || '').toUpperCase();
      const subjTags = (ctx.subject.specialtyTags || []).map(t => String(t).toUpperCase());
      return !!tag && subjTags.includes(tag);
    },
  },
  {
    name: 'specialty_case.read.managerial',
    version: 1,
    description: 'Manager/admin reads any specialty case in their branch',
    effect: 'PERMIT',
    priority: 70,
    actions: ['read'],
    resourceTypes: ['specialty_case','specialty_visit'],
    condition: (ctx) =>
      ['manager','clinic_admin','org_admin','admin'].includes(ctx.subject.role) &&
      (!ctx.subject.branchId || ctx.resource.branchId === ctx.subject.branchId),
  },
  {
    name: 'specialty_case.update.own_active',
    version: 1,
    description: 'Case owner updates active specialty case',
    effect: 'PERMIT',
    priority: 60,
    actions: ['update'],
    resourceTypes: ['specialty_case','specialty_visit'],
    condition: (ctx) =>
      ctx.subject.role === 'doctor' &&
      ctx.resource.ownerId === ctx.subject.id &&
      (ctx.resource.status || '').toUpperCase() === 'ACTIVE',
  },
  {
    name: 'specialty_case.create.doctor',
    version: 1,
    description: 'Doctors create specialty cases in their specialty',
    effect: 'PERMIT',
    priority: 60,
    actions: ['create'],
    resourceTypes: ['specialty_case'],
    condition: (ctx) => ctx.subject.role === 'doctor',
  },
];
