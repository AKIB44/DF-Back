// ────────────────────────────────────────────────────────────────────────────
// Inventory & traceability policies — PRD §5.3 catalog 19-21
// ────────────────────────────────────────────────────────────────────────────

module.exports = [
  {
    name: 'inventory.read.all_clinical',
    version: 1,
    description: 'Every authenticated staff role can read inventory',
    effect: 'PERMIT',
    priority: 60,
    actions: ['read'],
    resourceTypes: ['inventory_item','stock_movement','lab_order'],
    condition: () => true,
  },
  {
    name: 'inventory.adjustment.manager_only',
    version: 1,
    description: 'Stock adjustments require manager or above',
    effect: 'PERMIT',
    priority: 70,
    actions: ['create','update'],
    resourceTypes: ['stock_movement'],
    condition: (ctx) =>
      (ctx.subject.hierarchyLevel ?? 0) >= 80 ||
      ['manager','clinic_admin','org_admin','admin'].includes(ctx.subject.role),
  },
  {
    name: 'lab_order.create.clinical',
    version: 1,
    description: 'Doctors and lab technicians create lab orders',
    effect: 'PERMIT',
    priority: 60,
    actions: ['create','update'],
    resourceTypes: ['lab_order'],
    condition: (ctx) =>
      ['doctor','lab_tech','manager','clinic_admin','org_admin'].includes(ctx.subject.role) &&
      !ctx.resource.sealedAt,
  },
  {
    name: 'patient_device_register.delete.two_person',
    version: 1,
    description: 'Device register deletion needs two-person auth',
    effect: 'PERMIT',
    priority: 85,
    actions: ['delete'],
    resourceTypes: ['patient_device_register'],
    condition: (ctx) =>
      ['super_admin','org_admin'].includes(ctx.subject.role) &&
      ctx.resource.extras?.second_approver_confirmed === true,
  },
];
