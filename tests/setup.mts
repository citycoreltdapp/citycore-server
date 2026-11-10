import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll } from 'vitest';

// A replica set, because wallet crediting uses transactions. This must be set before anything
// imports src/config/env.
const mongo = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
});
process.env.MONGODB_URI = mongo.getUri('city-core-test');

afterAll(async () => {
  await mongo.stop();
});
