const { Queue } = require('bullmq');
const connection = require('../config/redisConfig.js');

const PUBLISH_QUEUE_NAME = 'publish';

const publishQueue = new Queue(PUBLISH_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 1000
    }
});

module.exports = { publishQueue, PUBLISH_QUEUE_NAME };
