const MANAGERIAL = ['manager', 'clinic_admin', 'org_admin', 'admin', 'super_admin'];

module.exports = [
  {
    name: 'service_performed.update.owner_or_manager_unsealed',
    version: 1,
    description: 'Service changes require session owner or manager on an unsealed session',
    effect: 'PERMIT',
    priority: 60,
    actions: ['update', 'delete'],
    resourceTypes: ['service_performed'],
    condition: (ctx) => {
      const sameBranch = !ctx.subject.branchId || ctx.resource.branchId === ctx.subject.branchId;
      const owner = ctx.subject.role === 'doctor' && ctx.resource.ownerId === ctx.subject.id;
      const manager = MANAGERIAL.includes(ctx.subject.role) && sameBranch;
      return (owner || manager) &&
        ctx.resource.status !== 'COMPLETED' &&
        ctx.resource.status !== 'completed' &&
        !ctx.resource.sealedAt;
    },
  },
  {
    name: 'service_performed.create.doctor_or_manager',
    version: 1,
    description: 'Doctors and managers create services on authorized sessions',
    effect: 'PERMIT',
    priority: 60,
    actions: ['create'],
    resourceTypes: ['service_performed'],
    condition: (ctx) =>
      ['doctor', ...MANAGERIAL].includes(ctx.subject.role) &&
      !ctx.resource.sealedAt,
  },
];
