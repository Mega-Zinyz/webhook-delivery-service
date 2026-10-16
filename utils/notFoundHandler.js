function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource does not exist',
  });
}

module.exports = notFoundHandler;
