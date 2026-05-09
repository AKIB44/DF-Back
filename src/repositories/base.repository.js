const db = require('../db');

class BaseRepository {
  constructor(table) {
    this.table = table;
  }

  async find(ctx, where = {}, opts = {}) {
    if (!ctx?.clinicId && !opts.crossClinic) {
      throw new Error(`TenantScopeMissing on ${this.table}`);
    }

    const conds = [];
    const args  = [];

    if (!opts.crossClinic) {
      conds.push(`clinic_id = $${args.length + 1}`);
      args.push(ctx.clinicId);
    }

    for (const [k, v] of Object.entries(where)) {
      conds.push(`"${k}" = $${args.length + 1}`);
      args.push(v);
    }

    const where_clause = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = opts.limit || 100;
    args.push(limit);

    const { rows } = await db.query(
      `SELECT * FROM "${this.table}" ${where_clause} LIMIT $${args.length}`,
      args
    );
    return rows;
  }

  async findById(ctx, id, opts = {}) {
    if (!ctx?.clinicId && !opts.crossClinic) {
      throw new Error(`TenantScopeMissing on ${this.table}`);
    }
    const { rows } = await db.query(
      `SELECT * FROM "${this.table}" WHERE id = $1 AND clinic_id = $2`,
      [id, ctx.clinicId]
    );
    return rows[0] || null;
  }

  async insert(ctx, data) {
    if (!ctx?.orgId || !ctx?.clinicId) {
      throw new Error(`TenantScopeMissing on ${this.table}`);
    }
    const payload = { ...data, org_id: ctx.orgId, clinic_id: ctx.clinicId };
    const keys   = Object.keys(payload);
    const values = Object.values(payload);
    const cols   = keys.map(k => `"${k}"`).join(', ');
    const params = keys.map((_, i) => `$${i + 1}`).join(', ');

    const { rows } = await db.query(
      `INSERT INTO "${this.table}" (${cols}) VALUES (${params}) RETURNING *`,
      values
    );
    return rows[0];
  }

  async update(ctx, id, data) {
    if (!ctx?.clinicId) throw new Error(`TenantScopeMissing on ${this.table}`);
    const keys   = Object.keys(data);
    const values = Object.values(data);
    const sets   = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    values.push(id, ctx.clinicId);

    const { rows } = await db.query(
      `UPDATE "${this.table}" SET ${sets}
       WHERE id = $${values.length - 1} AND clinic_id = $${values.length}
       RETURNING *`,
      values
    );
    return rows[0] || null;
  }
}

module.exports = BaseRepository;
