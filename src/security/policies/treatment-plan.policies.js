const CLINICAL_ROLES = ['doctor', 'hygienist', 'assistant', 'manager', 'clinic_admin', 'org_admin', 'admin', 'super_admin'];
const MANAGERIAL = ['manager', 'clinic_admin', 'org_admin', 'admin', 'super_admin'];

module.exports = [
  {
    name: 'treatment_plan.read.clinical_or_reception',
    version: 1,
    description: 'Clinical staff and reception can read treatment plans for active patient workflows',
    effect: 'PERMIT',
    priority: 50,
    actions: ['read'],
    resourceTypes: ['treatment_plan'],
    condition: (ctx) => [...CLINICAL_ROLES, 'reception'].includes(ctx.subject.role),
  },
  {
    name: 'treatment_plan.write.clinical_or_manager',
    version: 1,
    description: 'Clinical staff and managers can create and update treatment plans in their branch',
    effect: 'PERMIT',
    priority: 60,
    actions: ['create', 'update'],
    resourceTypes: ['treatment_plan', 'treatment_plan_item'],
    condition: (ctx) => {
      const sameBranch = !ctx.subject.branchId || !ctx.resource.branchId || ctx.resource.branchId === ctx.subject.branchId;
      return sameBranch && (CLINICAL_ROLES.includes(ctx.subject.role) || MANAGERIAL.includes(ctx.subject.role));
    },
  },
];
