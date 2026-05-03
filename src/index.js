require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const logger  = require('./middleware/logger');

const app = express();
app.use(cors());
app.use(express.json());
app.use(logger);

app.use('/v1/auth',         require('./routes/auth'));
app.use('/v1/clinic',       require('./routes/clinic'));
app.use('/v1/chairs',       require('./routes/chairs'));
app.use('/v1/services',     require('./routes/services'));
app.use('/v1/staff',        require('./routes/staff'));
app.use('/v1/patients',     require('./routes/patients'));
app.use('/v1/appointments', require('./routes/appointments'));

app.get('/health', (_, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[UNHANDLED ERROR] ${req.method} ${req.originalUrl}`);
    console.error(err.stack);
  }
  res.status(status).json({ error: err.message || 'Internal server error' });
});

app.listen(process.env.PORT || 3000, () =>
  console.log(`DentaFlow backend running on :${process.env.PORT || 3000}`)
);
