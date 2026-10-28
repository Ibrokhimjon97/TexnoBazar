import pg from 'pg';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const envText = fs.readFileSync('.env.local', 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx !== -1) {
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
let dbUrl = env.SUPABASE_DB_URL;
if (dbUrl && dbUrl.includes(':5432')) {
  dbUrl = dbUrl.replace(':5432', ':6543');
}

const client = new pg.Client({ 
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await client.connect();
  
  const archiveDir = path.resolve('archives/audit');
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  // Parameter: days to keep (default: archive older than 7 days)
  const daysToKeep = parseInt(process.argv[2] || '7', 10);
  const cutoffDateRes = await client.query(`SELECT (now() - interval '${daysToKeep} days') as cutoff`);
  const cutoff = cutoffDateRes.rows[0].cutoff;
  console.log(`Archiving audit_log records created before: ${cutoff} (older than ${daysToKeep} days)...`);

  const countRes = await client.query(
    `SELECT count(*) as count FROM public.audit_log WHERE created_at < now() - interval '${daysToKeep} days'`
  );
  const totalToArchive = parseInt(countRes.rows[0].count, 10);
  console.log(`Total rows to archive: ${totalToArchive}`);

  if (totalToArchive === 0) {
    console.log('No rows to archive.');
    await client.end();
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `audit_log_archive_${daysToKeep}d_older_${timestamp}.json.gz`;
  const filePath = path.join(archiveDir, filename);

  const writeStream = fs.createWriteStream(filePath);
  const gzipStream = zlib.createGzip();
  gzipStream.pipe(writeStream);

  gzipStream.write('[\n');

  const batchSize = 2500;
  let offset = 0;
  let isFirst = true;

  while (offset < totalToArchive) {
    const res = await client.query(
      `SELECT id, actor_id, action, entity_schema, entity_table, entity_id, old_data, new_data, request_id, ip, user_agent, created_at
       FROM public.audit_log
       WHERE created_at < now() - interval '${daysToKeep} days'
       ORDER BY id ASC
       LIMIT $1 OFFSET $2`,
      [batchSize, offset]
    );

    for (const row of res.rows) {
      const line = (isFirst ? '' : ',\n') + JSON.stringify(row);
      gzipStream.write(line);
      isFirst = false;
    }

    offset += res.rows.length;
    process.stdout.write(`Exported ${offset} / ${totalToArchive} rows...\r`);
    if (res.rows.length === 0) break;
  }

  gzipStream.write('\n]');
  gzipStream.end();

  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  const stats = fs.statSync(filePath);
  console.log(`\nArchive successfully saved to: ${filePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB compressed)`);

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
