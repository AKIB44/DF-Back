// ────────────────────────────────────────────────────────────────────────────
// Billing & financial policies — PRD §5.3 catalog 11-14
// ────────────────────────────────────────────────────────────────────────────

const BILLING_ROLES = ['reception','accountant','manager','clinic_admin','org_admin','admin'];

module.exports = [
  {
    name: 'charge_line.read.assistant_deny',
    version: 1,
    description: 'Assistants cannot view financial data',
    effect: 'DENY',
    priority: 95,
    actions: ['read'],
    resourceTypes: ['charge_line','payment','invoice'],
    condition: (ctx) => ctx.subject.role === 'assistant',
  },
  {
    name: 'charge_line.read.billing_roles',
    version: 1,
    description: 'Reception/accountant/manager read charges, payments, invoices',
    effect: 'PERMIT',
    priority: 60,
    actions: ['read'],
    resourceTypes: ['charge_line','payment','invoice'],
    condition: (ctx) => BILLING_ROLES.includes(ctx.subject.role),
  },
  {
    name: 'charge_line.read.doctor',
    version: 1,
    description: 'Doctor reads charges for their own sessions',
    effect: 'PERMIT',
    priority: 55,
    actions: ['read'],
    resourceTypes: ['charge_line','payment','invoice'],
    condition: (ctx) =>
      ctx.subject.role === 'doctor' &&
      (ctx.resource.ownerId === ctx.subject.id || !ctx.resource.ownerId),
  },
  {
    name: 'payment.create.billing_roles',
    version: 1,
    description: 'Billing-capable roles record payments',
    effect: 'PERMIT',
    priority: 60,
    actions: ['create','update'],
    resourceTypes: ['payment','invoice','charge_line'],
    condition: (ctx) => BILLING_ROLES.includes(ctx.subject.role),
  },
  {
    name: 'discount.deny.above_hard_cap',
    version: 1,
    description: 'Discount above hard cap blocked for everyone except super_admin',
    effect: 'DENY',
    priority: 99,
    actions: ['approve_discount'],
    resourceTypes: ['service_performed','charge_line'],
    condition: (ctx) => {
      const pct = ctx.resource.extras?.discount_pct ?? 0;
      const hardCap = ctx.resource.extras?.discount_hard_cap ?? 30;
      return pct > hardCap && ctx.subject.role !== 'super_admin' && ctx.subject.role !== 'org_admin';
    },
  },
  {
    name: 'discount.approve.threshold',
    version: 1,
    description: 'Discount above auto-threshold requires higher hierarchy',
    effect: 'PERMIT',
    priority: 75,
    actions: ['approve_discount'],
    resourceTypes: ['service_performed','charge_line'],
    condition: (ctx) => {
      const pct = ctx.resource.extras?.discount_pct ?? 0;
      const auto = ctx.resource.extras?.discount_auto_threshold ?? (ctx.subject.maxDiscountPct ?? 10);
      if (pct <= auto) return true;
      return (ctx.subject.hierarchyLevel ?? 0) >= 80;
    },
  },
  {
    name: 'billing.export.manager_only',
    version: 1,
    description: 'Billing exports require manager and above',
    effect: 'PERMIT',
    priority: 85,
    actions: ['export'],
    resourceTypes: ['charge_line','payment','invoice'],
    condition: (ctx) => (ctx.subject.hierarchyLevel ?? 0) >= 80,
  },
];
