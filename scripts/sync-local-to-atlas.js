import { MongoClient } from 'mongodb';

const TARGET_URI = process.argv[2] || process.env.ATLAS_MONGO_URI || process.env.TARGET_MONGO_URI || '';
const LOCAL_URI = process.argv[3] || process.env.LOCAL_MONGO_URI || 'mongodb://127.0.0.1:27017/hrm_th79';
const BATCH_SIZE = 1000;

function maskUri(uri) {
  return uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

async function copyCollection(sourceDb, targetDb, name) {
  const sourceCol = sourceDb.collection(name);
  const targetCol = targetDb.collection(name);

  await targetCol.deleteMany({});

  let copied = 0;
  let batch = [];
  const cursor = sourceCol.find({});

  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH_SIZE) {
      await targetCol.insertMany(batch, { ordered: true });
      copied += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await targetCol.insertMany(batch, { ordered: true });
    copied += batch.length;
  }

  const indexes = await sourceCol.indexes();
  for (const index of indexes) {
    if (index.name === '_id_') continue;
    const { key, v, ns, ...options } = index;
    await targetCol.createIndex(key, options);
  }

  return copied;
}

async function main() {
  if (!TARGET_URI) {
    console.error('\n❌ Thiếu chuỗi kết nối MongoDB Atlas.');
    console.error('Cách dùng: node scripts/sync-local-to-atlas.js "<ATLAS_MONGODB_URI>" [LOCAL_MONGODB_URI]\n');
    process.exit(1);
  }

  if (TARGET_URI === LOCAL_URI) {
    console.error('\n❌ URI đích trùng với URI nguồn, dừng lại để tránh ghi đè nhầm.\n');
    process.exit(1);
  }

  const localClient = new MongoClient(LOCAL_URI);
  const targetClient = new MongoClient(TARGET_URI);

  try {
    console.log(`\n🔌 Kết nối nguồn (Local): ${maskUri(LOCAL_URI)}`);
    await localClient.connect();
    const sourceDb = localClient.db();

    console.log(`🔌 Kết nối đích (Atlas): ${maskUri(TARGET_URI)}`);
    await targetClient.connect();
    const targetDb = targetClient.db();

    const collections = (await sourceDb.listCollections().toArray())
      .map(c => c.name)
      .filter(name => !name.startsWith('system.'));

    console.log(`\n📦 Tìm thấy ${collections.length} collection(s) trong '${sourceDb.databaseName}'. Bắt đầu đồng bộ sang '${targetDb.databaseName}'...\n`);

    let totalDocs = 0;
    for (const name of collections) {
      const count = await copyCollection(sourceDb, targetDb, name);
      totalDocs += count;
      console.log(`  ✅ ${name}: ${count} bản ghi`);
    }

    console.log(`\n🎉 Hoàn tất! Đã đồng bộ ${collections.length} collection(s), tổng ${totalDocs} bản ghi lên MongoDB Atlas.\n`);
  } catch (error) {
    console.error('\n❌ Lỗi khi đồng bộ dữ liệu:', error.message);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([localClient.close(), targetClient.close()]);
  }
}

main();
