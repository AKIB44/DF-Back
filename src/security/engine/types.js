// ────────────────────────────────────────────────────────────────────────────
// Policy engine — shared type vocabulary (JSDoc; runtime is JS)
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {'read'|'create'|'update'|'delete'|'export'|'seal'|'reopen'|'approve_discount'|'assign'|'transfer'|'archive'} Action
 */

/**
 * @typedef {'patient'|'booking'|'session'|'service_performed'|'charge_line'|'payment'|'invoice'|'diagnosis'|'examination'|'clinical_note'|'prescription'|'consent_record'|'attachment'|'investigation'|'treatment_plan'|'treatment_plan_item'|'specialty_case'|'specialty_visit'|'inventory_item'|'stock_movement'|'lab_order'|'staff'|'clinic_settings'|'patient_device_register'|'audit_log'} ResourceType
 */

/**
 * @typedef {'PERMIT'|'DENY'} Effect
 * @typedef {'PERMIT'|'DENY'} Decision
 */

/**
 * @typedef {Object} Subject
 * @property {string} id              user UUID
 * @property {string} role            RBAC role code (clinic_admin, doctor, …)
 * @property {string[]} specialtyTags ['ORTHODONTIC', 'IMPLANTOLOGY', …]
 * @property {string|null} branchId   clinic_id (acts as branch in v1)
 * @property {number} hierarchyLevel  numeric weight from roles.hierarchy_level
 * @property {number} [maxDiscountPct]
 */

/**
 * @typedef {Object} Resource
 * @property {ResourceType} type
 * @property {string} [id]
 * @property {string} [ownerId]       primary_doctor_id or created_by
 * @property {string} [patientId]
 * @property {string} [status]        domain status (COMPLETED, ACTIVE, …)
 * @property {string} [branchId]
 * @property {string} [specialtyCaseType]
 * @property {Date}   [sealedAt]
 * @property {Object} [extras]        free-form bag for resource-specific attrs
 */

/**
 * @typedef {Object} Environment
 * @property {Date}   now
 * @property {string} ipAddress
 * @property {string} userAgent
 * @property {string} requestId
 */

/**
 * @typedef {Object} PolicyContext
 * @property {Subject} subject
 * @property {Resource} resource
 * @property {Action} action
 * @property {Environment} environment
 */

/**
 * @typedef {Object} Policy
 * @property {string} name                                      e.g. 'session.read.own'
 * @property {number} version
 * @property {string} description
 * @property {Effect} effect
 * @property {number} priority                                   higher evaluates first
 * @property {Action[]} actions
 * @property {ResourceType[]} resourceTypes
 * @property {(ctx: PolicyContext) => boolean} condition
 */

/**
 * @typedef {Object} DecisionResult
 * @property {Decision} decision
 * @property {string}   policy             policy name that produced the decision
 * @property {number}   [policyVersion]
 * @property {string}   [reason]
 */

module.exports = {};
