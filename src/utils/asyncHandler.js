// src/utils/asyncHandler.js

// Express 4 does not catch a rejected promise from an async handler: without this
// wrapper a single bad request (a TypeError, a DB error) becomes an unhandled
// rejection and Node exits. With it, the error goes to the error middleware.
// Works on Express 4 and 5.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);