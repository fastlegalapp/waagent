'use strict';

// Shared readiness state, surfaced on /api/health so a load balancer / panel
// can tell the difference between "app up, DB still connecting" and "app down".
const state = { db: false };

module.exports = state;
