-- Add phone to staff/users for OTP login
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(15);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users (phone) WHERE phone IS NOT NULL;
