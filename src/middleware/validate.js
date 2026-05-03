function makeValidator(getData) {
  return (schema) => (req, res, next) => {
    const { error } = schema.validate(getData(req), { abortEarly: false });
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map((d) => d.message),
      });
    }
    next();
  };
}

module.exports = makeValidator((req) => req.body);
module.exports.query = makeValidator((req) => req.query);
