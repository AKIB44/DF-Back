const express      = require('express');
const authenticate = require('../middleware/authenticate');
const ctrl         = require('./webauthn.controller');

const router = express.Router();

// All ceremonies require a logged-in user (biometric is a step-up factor).
router.post('/register/options', authenticate, ctrl.registerOptions);
router.post('/register/verify',  authenticate, ctrl.registerVerify);
router.get('/credentials',       authenticate, ctrl.listCredentials);
router.delete('/credentials/:id', authenticate, ctrl.deleteCredential);
router.post('/auth/options',     authenticate, ctrl.authOptions);
router.post('/auth/verify',      authenticate, ctrl.authVerify);

module.exports = router;
