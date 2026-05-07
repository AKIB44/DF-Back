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

    // Explicitly mark as IST so Node.js doesn't misparse as UTC.
    const slotStart = `${date}T${slotTime}:00+05:30`;
    const slotEnd   = new Date(new Date(slotStart).getTime() + slotSize * 60000).toISOString();

    const conflict = await db.query(
      `SELECT id FROM appointments
       WHERE chair_id = $1
         AND ($2::uuid IS NULL OR clinic_id = $2)
         AND status NOT IN ('cancelled','no_show')
         AND scheduled_at < $3
         AND scheduled_at + (duration_minutes * interval '1 minute') > $4
       LIMIT 1`,
      [chairId, clinicId || null, slotEnd, slotStart]
    );

    slots.push({ time: slotTime, taken: conflict.rows.length > 0 });
  }

  return slots;
}

module.exports = { generateSlots };
