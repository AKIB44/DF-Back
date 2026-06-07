// ────────────────────────────────────────────────────────────────────────────
// Session policies — PRD §5.3 catalog 1-7
// ────────────────────────────────────────────────────────────────────────────
// All seven session policies plus a manager-branch read that mirrors the
// PRD's same_branch rule. The engine evaluates in priority order so the
// 'session.update.sealed_deny' (90) fires before any owner-permit (60).
// ────────────────────────────────────────────────────────────────────────────

const CLINICAL_MANAGERIAL = ['manager', 'clinic_admin', 'org_admin', 'admin', 'super_admin'];

module.exports = [
  {
    name: 'session.read.own',
    version: 1,
    description: 'Doctor reads their own sessions',
    effect: 'PERMIT',
    priority: 60,
    actions: ['read'],
    resourceTypes: ['session'],
    condition: (ctx) =>
      ctx.subject.role === 'doctor' &&
      !!ctx.resource.ownerId &&
      ctx.resource.ownerId === ctx.subject.id,
  },
  {
    name: 'session.read.same_branch',
    version: 1,
    description: 'Manager/admin reads sessions in their branch (branch-scoped tenants)',
    effect: 'PERMIT',
    priority: 70,
    actions: ['read'],
    resourceTypes: ['session'],
    condition: (ctx) =>
      CLINICAL_MANAGERIAL.includes(ctx.subject.role) &&
      !!ctx.subject.branchId &&
      ctx.resource.branchId === ctx.subject.branchId,
  },
  {
    name: 'session.read.managerial_clinic',
    version: 1,
    description: 'Managerial roles read sessions in their clinic when no branch scoping is configured',
    effect: 'PERMIT',
    priority: 65,
    actions: ['read'],
    resourceTypes: ['session'],
    condition: (ctx) =>
      CLINICAL_MANAGERIAL.includes(ctx.subject.role) &&
      (!ctx.subject.branchId || !ctx.resource.branchId),
  },
  {
    name: 'session.read.doctor_clinic',
    version: 1,
    description: 'Doctor reads sessions in their clinic (covers loading patient profiles, lab history, etc.)',
    effect: 'PERMIT',
    priority: 55,
    actions: ['read'],
    resourceTypes: ['session'],
    condition: (ctx) => ctx.subject.role === 'doctor',
  },
  {
    name: 'session.read.reception_status',
    version: 1,
    description: 'Reception reads session metadata for scheduling and billing',
    effect: 'PERMIT',
    priority: 45,
    actions: ['read'],
    resourceTypes: ['session'],
    condition: (ctx) => ctx.subject.role === 'reception',
  },
  {
    name: 'session.read.assistant_in_session',
    version: 1,
    description: 'Assistant/hygienist reads sessions they participated in',
    effect: 'PERMIT',
    priority: 50,
    actions: ['read'],
    resourceTypes: ['session'],
    condition: (ctx) => {
      if (!['assistant', 'hygienist'].includes(ctx.subject.role)) return false;
      const ids = ctx.resource.extras?.assistant_ids || ctx.resource.assistantIds || [];
      return Array.isArray(ids) && ids.includes(ctx.subject.id);
    },
  },
  {
    name: 'session.update.own_unsealed',
    version: 1,
    description: 'Doctor updates own session only if not sealed',
    effect: 'PERMIT',
    priority: 60,
    actions: ['update'],
    resourceTypes: ['session'],
    condition: (ctx) =>
      ctx.subject.role === 'doctor' &&
      ctx.resource.ownerId === ctx.subject.id &&
      ctx.resource.status !== 'COMPLETED' &&
      ctx.resource.status !== 'completed' &&
      !ctx.resource.sealedAt,
  },
  {
    name: 'session.update.manager_unsealed',
    version: 1,
    description: 'Manager/admin updates unsealed sessions in their branch',
    effect: 'PERMIT',
    priority: 55,
    actions: ['update'],
    resourceTypes: ['session'],
    condition: (ctx) =>
      CLINICAL_MANAGERIAL.includes(ctx.subject.role) &&
      (!ctx.subject.branchId || ctx.resource.branchId === ctx.subject.branchId) &&
      ctx.resource.status !== 'COMPLETED' &&
      ctx.resource.status !== 'completed' &&
      !ctx.resource.sealedAt,
  },
  {
    name: 'session.update.sealed_deny',
    version: 1,
    description: 'Sealed sessions cannot be updated — addenda only',
    effect: 'DENY',
    priority: 90,
    actions: ['update'],
    resourceTypes: ['session'],
    condition: (ctx) =>
      ctx.resource.status === 'COMPLETED' ||
      ctx.resource.status === 'completed' ||
      !!ctx.resource.sealedAt,
  },
  {
    name: 'session.reopen.manager_within_window',
    version: 1,
    description: 'Manager reopens sealed session within 30 minutes',
    effect: 'PERMIT',
    priority: 80,
    actions: ['reopen'],
    resourceTypes: ['session'],
    condition: (ctx) => {
      if (!CLINICAL_MANAGERIAL.includes(ctx.subject.role)) return false;
      const sealedAt = ctx.resource.sealedAt;
      if (!sealedAt) return false;
      const ms = ctx.environment.now.getTime() - new Date(sealedAt).getTime();
      const windowMin = ctx.resource.extras?.reopen_window_minutes ?? 30;
      return ms / 60000 <= windowMin;
    },
  },
  {
    name: 'session.seal.own',
    version: 1,
    description: 'Doctor seals their own session',
    effect: 'PERMIT',
    priority: 60,
    actions: ['seal'],
    resourceTypes: ['session'],
    condition: (ctx) =>
      ctx.subject.role === 'doctor' &&
      ctx.resource.ownerId === ctx.subject.id,
  },
  {
    name: 'session.seal.manager',
    version: 1,
    description: 'Manager / clinic admin / org admin can seal sessions in their scope',
    effect: 'PERMIT',
    priority: 60,
    actions: ['seal'],
    resourceTypes: ['session'],
    condition: (ctx) =>
      ['manager', 'clinic_admin', 'admin', 'org_admin', 'super_admin'].includes(ctx.subject.role),
  },
  {
    name: 'session.create.doctor',
    version: 1,
    description: 'Doctor creates sessions for their patients',
    effect: 'PERMIT',
    priority: 60,
    actions: ['create'],
    resourceTypes: ['session'],
    condition: (ctx) =>
      ['doctor', 'manager', 'clinic_admin', 'org_admin', 'admin', 'super_admin'].includes(ctx.subject.role),
  },
];
