const db = require('../db');

const CLINIC_START = 9;   // 09:00
const CLINIC_END   = 20;  // 20:00

async function generateSlots({ date, serviceId, chairId, clinicId }) {
  const svcResult = await db.query(
    `SELECT duration_minutes FROM services WHERE id = $1 AND is_active = true`,
    [serviceId]
  );
  if (!svcResult.rows.length) throw Object.assign(new Error('Service not found'), { status: 404 });

  const slotSize = svcResult.rows[0].duration_minutes;
  const slots = [];

  for (let start = CLINIC_START * 60; start + slotSize <= CLINIC_END * 60; start += slotSize) {
    const hh = String(Math.floor(start / 60)).padStart(2, '0');
    const mm = String(start % 60).padStart(2, '0');
    const slotTime = `${hh}:${mm}`;

    const slotStart = `${date}T${slotTime}:00+05:30`;

    const conflict = await db.query(
      `SELECT id FROM appointments
       WHERE chair_id = $1
         AND ($2::uuid IS NULL OR clinic_id = $2)
         AND status NOT IN ('cancelled','no_show')
         AND tstzrange(scheduled_at, scheduled_at + duration_minutes * interval '1 minute')
             && tstzrange($3::timestamptz, $3::timestamptz + $4 * interval '1 minute')
       LIMIT 1`,
      [chairId, clinicId || null, slotStart, slotSize]
    );

    slots.push({ time: slotTime, taken: conflict.rows.length > 0 });
  }

  return slots;
}

module.exports = { generateSlots };
