const express    = require('express');
const Joi        = require('joi');
const validate   = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const ctrl       = require('./auth.controller');

const router = express.Router();

const loginSchema = Joi.alternatives().try(
  Joi.object({ email:    Joi.string().trim().email().required(), password: Joi.string().required() }),
  Joi.object({ username: Joi.string().trim().email().required(), password: Joi.string().required() })
);

const otpRequestSchema = Joi.object({
  phone: Joi.string().pattern(/^\d{10}$/).required().messages({
    'string.pattern.base': 'phone must be a 10-digit number',
  }),
});

const otpVerifySchema = Joi.object({
  phone: Joi.string().pattern(/^\d{10}$/).required(),
  otp:   Joi.string().pattern(/^\d{6}$/).required().messages({
    'string.pattern.base': 'otp must be a 6-digit number',
  }),
});

router.post('/login',         validate(loginSchema),      ctrl.login);
router.post('/refresh',       ctrl.refresh);
router.post('/logout',        authenticate,               ctrl.logout);
router.get('/me',             authenticate,               ctrl.me);
router.get('/me/permissions', authenticate,               ctrl.myPermissions);
router.post('/switch-clinic', authenticate,               ctrl.switchClinic);
router.post('/step-up',       authenticate,               ctrl.stepUp);
router.post('/otp/request',   validate(otpRequestSchema), ctrl.requestOtp);
router.post('/otp/verify',    validate(otpVerifySchema),  ctrl.verifyOtp);

module.exports = router;
