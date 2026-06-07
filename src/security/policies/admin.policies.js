// ────────────────────────────────────────────────────────────────────────────
// Admin/clinic-settings/audit policies — PRD §5.3 catalog 23-24
// ────────────────────────────────────────────────────────────────────────────

const ADMIN_ROLES = ['admin','clinic_admin','org_admin','super_admin'];

module.exports = [
  {
    name: 'audit_log.read.admin_only',
    version: 1,
    description: 'Audit log visible to manager and above',
    effect: 'PERMIT',
    priority: 90,
    actions: ['read','export','update'],
    resourceTypes: ['audit_log'],
    condition: (ctx) =>
      [...ADMIN_ROLES, 'manager'].includes(ctx.subject.role) ||
      (ctx.subject.hierarchyLevel ?? 0) >= 80,
  },
  {
    name: 'clinic_settings.read.admin',
    version: 1,
    description: 'Clinic settings readable by admin and managers',
    effect: 'PERMIT',
    priority: 70,
    actions: ['read'],
    resourceTypes: ['clinic_settings'],
    condition: (ctx) =>
      [...ADMIN_ROLES, 'manager'].includes(ctx.subject.role),
  },
  {
    name: 'clinic_settings.update.admin_only',
    version: 1,
    description: 'Clinic settings update restricted to admins',
    effect: 'PERMIT',
    priority: 90,
    actions: ['update','create','delete'],
    resourceTypes: ['clinic_settings'],
    condition: (ctx) => ADMIN_ROLES.includes(ctx.subject.role),
  },
  {
    name: 'staff.manage.admin_only',
    version: 1,
    description: 'Only admins manage staff accounts and roles',
    effect: 'PERMIT',
    priority: 90,
    actions: ['create','update','delete'],
    resourceTypes: ['staff'],
    condition: (ctx) => ADMIN_ROLES.includes(ctx.subject.role),
  },
  {
    name: 'prescription.create.doctor_only',
    version: 1,
    description: 'Only doctors can create prescriptions',
    effect: 'PERMIT',
    priority: 70,
    actions: ['create','update'],
    resourceTypes: ['prescription'],
    condition: (ctx) => ctx.subject.role === 'doctor',
  },
];
