import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const PORT = process.env.PORT || 3000;

const server = await createApp({ dbFile: path.join(dataDir, 'stepbuddy.db'), dataDir });
console.log(`db: ${server.dbLabel}`);

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${PORT} is already in use — Wanderling may already be running in another terminal.`);
  console.error(`Stop that one (Ctrl+C there), or start this one elsewhere: PORT=${PORT + 1} npm start`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.log('  GEMINI_API_KEY not set — buddy uses built-in lines');
  if (!process.env.GOOGLE_MAPS_API_KEY) console.log('  GOOGLE_MAPS_API_KEY not set — the Map tab will ask for one');
  if (!process.env.ELEVENLABS_API_KEY) console.log('  ELEVENLABS_API_KEY not set — buddy uses the browser voice');
  if (process.env.DEMO_MODE === '1') console.log('  DEMO_MODE is on — add ?demo=1 to the address for the demo shortcuts');
  console.log(process.env.ADMIN_KEY ? `  Admin dashboard: http://localhost:${PORT}/admin/` : '  ADMIN_KEY not set — the admin dashboard is off');
  if (process.env.ADMIN_KEY && process.env.ADMIN_KEY.length < 24) {
    console.warn('  ADMIN_KEY is shorter than 24 characters — use a long random key, it opens every account');
  }
});
