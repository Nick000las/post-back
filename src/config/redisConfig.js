const IORedis = require('ioredis');

// maxRetriesPerRequest: null é exigido pelo BullMQ para conexões usadas por Worker/QueueEvents.
const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null
});

module.exports = connection;