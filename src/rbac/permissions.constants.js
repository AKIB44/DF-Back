const P = {
  APPOINTMENT_VIEW:   'appointment.view',
  APPOINTMENT_CREATE: 'appointment.create',
  APPOINTMENT_UPDATE: 'appointment.update',
  APPOINTMENT_CANCEL: 'appointment.cancel',

  PATIENT_VIEW:       'patient.view',
  PATIENT_CREATE:     'patient.create',
  PATIENT_UPDATE:     'patient.update',
  PATIENT_MH_VIEW:    'patient.medical_history.view',

  PRESCRIPTION_CREATE: 'prescription.create',
  PRESCRIPTION_SIGN:   'prescription.sign',

  BILLING_VIEW:   'billing.view',
  BILLING_CREATE: 'billing.create',
  BILLING_REFUND: 'billing.refund',
  BILLING_EXPORT: 'billing.export',
  EXPENSE_MANAGE: 'expense.manage',

  INVENTORY_ADJUST: 'inventory.adjust',

  STAFF_MANAGE:    'staff.manage',
  CLINIC_SETTINGS: 'clinic.settings',
  AUDIT_VIEW:      'audit.view',

  SERVICE_MANAGE_OWN: 'service.manage_own',

  SPECIALTY_VIEW:   'specialty.view',
  SPECIALTY_CREATE: 'specialty.create',
  SPECIALTY_UPDATE: 'specialty.update',

  FEATURE_FLAG_MANAGE: 'feature_flag.manage',

  ORG_MANAGE:      'org.manage',
  PLATFORM_MANAGE: 'platform.manage',

  PLATFORM_PLAN_MANAGE:    'platform.plan.manage',
  PLATFORM_TENANT_READ:    'platform.tenant.read',
  PLATFORM_TENANT_MANAGE:  'platform.tenant.manage',
  PLATFORM_BILLING_READ:   'platform.billing.read',
  PLATFORM_BILLING_MANAGE: 'platform.billing.manage',
};

module.exports = P;
