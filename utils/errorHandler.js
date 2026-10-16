function errorHandler(err, req, res, next) {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid JSON body',
    });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload Too Large', message: 'Request body exceeds 1mb' });
  }

  const status = err.status || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  console.error('Unhandled error:', err.message, { url: req.url, method: req.method });

  res.status(status).json({
    error: status >= 500 ? 'Internal Server Error' : err.name || 'Error',
    message: isProduction && status >= 500 ? 'An unexpected error occurred' : err.message,
  });
}

module.exports = errorHandler;
