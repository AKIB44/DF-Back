const logger = (req, res, next) => {
  const start = Date.now();

  // Capture the original res.json to intercept the response body
  const originalJson = res.json.bind(res);
  let responseBody;
  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    const ms      = Date.now() - start;
    const status  = res.statusCode;
    const isError = status >= 400;

    const line = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${status} (${ms}ms)`;

    if (isError) {
      console.error(line);
      if (responseBody?.error) console.error('  error:', responseBody.error);
      if (responseBody?.details) console.error('  details:', responseBody.details);
    } else {
      console.log(line);
    }
  });

  next();
};

module.exports = logger;
