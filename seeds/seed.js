require('dotenv').config();
const bcrypt       = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db           = require('../src/db');

/** Must match what clients send — bcrypt is case-sensitive (password123 ≠ Password123). */
const SEED_PLAINTEXT_PASSWORD = 'Password123';

async function seed() {
  const clinicId = uuidv4();

  await db.query(
    `INSERT INTO clinics (id, name, phone, email, address, city)
     VALUES ($1, 'Sharayu Dental Clinic', '9876543210', 'info@sharayudental.com', '123 Main St', 'Mumbai')`,
    [clinicId]
  );

  const hash = await bcrypt.hash(SEED_PLAINTEXT_PASSWORD, 10);
  await db.query(
    `INSERT INTO users (clinic_id, first_name, last_name, email, password_hash, role)
     VALUES
       ($1, 'Admin',    'User',   'admin@sharayudental.com',      $2, 'admin'),
       ($1, 'Dr. Priya','Sharma', 'doctor@sharayudental.com',     $2, 'doctor'),
       ($1, 'Akib',     'T',      'reception@sharayudental.com',  $2, 'receptionist')`,
    [clinicId, hash]
  );

  const services = [
    ['Oral Prophylaxis', 30,  800],
    ['Restoration',      45, 1500],
    ['Root Canal',       60, 3500],
    ['Extraction',       30, 1200],
    ['Orthodontics',     60, 5000],
    ['Implant',          90, 15000],
    ['Pulpectomy',       45, 2500],
  ];
  for (const [name, duration, price] of services) {
    await db.query(
      `INSERT INTO services (clinic_id, name, duration_minutes, price) VALUES ($1,$2,$3,$4)`,
      [clinicId, name, duration, price]
    );
  }

  await db.query(
    `INSERT INTO chairs (clinic_id, name) VALUES ($1,'Chair 1'), ($1,'Chair 2')`,
    [clinicId]
  );

  console.log('Seed complete.');
  console.log('clinic_id:', clinicId);
  console.log(
    `Login (email + password): admin@sharayudental.com / ${SEED_PLAINTEXT_PASSWORD}`
  );
}

seed()
  .catch(console.error)
  .finally(async () => {
    try {
      await db.pool.end();
    } catch (_) {
      /* ignore */
    }
    process.exit();
  });
