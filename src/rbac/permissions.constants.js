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

  // Marketing module (PRD_MARKETING_STRATEGY_MODULE)
  MKT_CAMPAIGN_VIEW:    'marketing.campaign.view',
  MKT_CAMPAIGN_CREATE:  'marketing.campaign.create',
  MKT_CAMPAIGN_EDIT:    'marketing.campaign.edit',
  MKT_CAMPAIGN_DELETE:  'marketing.campaign.delete',
  MKT_CAMPAIGN_SEND:    'marketing.campaign.send',
  MKT_CALENDAR_VIEW:    'marketing.calendar.view',
  MKT_CALENDAR_CREATE:  'marketing.calendar.create',
  MKT_CALENDAR_EDIT:    'marketing.calendar.edit',
  MKT_CALENDAR_DELETE:  'marketing.calendar.delete',
  MKT_PIPELINE_VIEW:    'marketing.pipeline.view',
  MKT_PIPELINE_EDIT:    'marketing.pipeline.edit',
  MKT_ONBOARDING_VIEW:  'marketing.onboarding.view',
  MKT_ONBOARDING_EDIT:  'marketing.onboarding.edit',
  MKT_PITCH_VIEW:       'marketing.pitch.view',
  MKT_PITCH_EDIT:       'marketing.pitch.edit',
  MKT_REVENUE_VIEW:     'marketing.revenue.view',
  MKT_EXPENSE_VIEW:     'marketing.expense.view',
  MKT_EXPENSE_CREATE:   'marketing.expense.create',
  MKT_EXPENSE_EDIT:     'marketing.expense.edit',
  MKT_TEAM_MANAGE:      'marketing.team.manage',
  MKT_TASK_VIEW_ALL:    'marketing.task.view_all',
  MKT_TASK_VIEW_OWN:    'marketing.task.view_own',
  MKT_TASK_EDIT:        'marketing.task.edit',
  MKT_SEGMENT_VIEW:     'marketing.segment.view',
  MKT_SEGMENT_CREATE:   'marketing.segment.create',
  MKT_PROMOCODE_VIEW:   'marketing.promocode.view',
  MKT_PROMOCODE_CREATE: 'marketing.promocode.create',
  MKT_PROMOCODE_EDIT:   'marketing.promocode.edit',

  // Marketing v2 (PRD_MARKETING_STRATEGY_MODULE_V2)
  MKT_FEEDBACK_VIEW:          'marketing.feedback.view',
  MKT_FEEDBACK_CREATE:        'marketing.feedback.create',
  MKT_CALLER_FEEDBACK_VIEW:   'marketing.caller_feedback.view',
  MKT_ACCEPTANCE_VIEW:        'marketing.acceptance.view',
  MKT_ACCEPTANCE_EDIT:        'marketing.acceptance.edit',
  MKT_CALLQUEUE_VIEW_OWN:     'marketing.callqueue.view_own',
  MKT_CALLQUEUE_VIEW_ALL:     'marketing.callqueue.view_all',
  MKT_CALLOUTCOME_CREATE:     'marketing.calloutcome.create',
  MKT_CALLBACK_SCHEDULE:      'marketing.callback.schedule',
  MKT_ENQUIRY_VIEW:           'marketing.enquiry.view',
  MKT_ENQUIRY_EDIT:           'marketing.enquiry.edit',
  MKT_SCHEDULED_CALLS_VIEW:   'marketing.scheduled_calls.view',
  MKT_SCHEDULED_CALLS_CREATE: 'marketing.scheduled_calls.create',
  MKT_LEADFINDER_MANAGE:      'marketing.leadfinder.manage',
};

module.exports = P;
