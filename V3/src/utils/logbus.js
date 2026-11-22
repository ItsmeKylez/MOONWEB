'use strict';
/* In-process event bus. Emits 'activity' ({ guildId, kind: 'case' | 'audit', id }) whenever a new
   entry reaches the moderation log, so the dashboard's live stream can push it to open pages. */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open dashboard stream

module.exports = bus;
