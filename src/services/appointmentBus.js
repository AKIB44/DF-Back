'use strict';

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(500); // one listener per open SSE connection

module.exports = bus;
