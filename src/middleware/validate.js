function makeValidator(getData, setData) {
  return (schema) => (req, res, next) => {
    const { error, value } = schema.validate(getData(req), { abortEarly: false });
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map((d) => d.message),
      });
    }
    setData(req, value);
    next();
  };
}

module.exports = makeValidator((req) => req.body, (req, value) => { req.body = value; });
module.exports.query = makeValidator((req) => req.query, (req, value) => { req.query = value; });
