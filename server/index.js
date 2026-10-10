import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const port = Number(process.env.PORT) || 3000;

const server = await createApp({ dbFile: path.join(dataDir, 'stepbuddy.db'), dataDir });
console.log(`db: ${server.dbLabel}`);

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${port} is already in use — StepBuddy may already be running in another terminal.`);
  console.error(`Stop that one (Ctrl+C there), or start this one elsewhere: PORT=${port + 1} npm start`);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`StepBuddy running at http://localhost:${port}  (demo mode: http://localhost:${port}/?demo=1)`);
  if (!process.env.GEMINI_API_KEY) console.log('  GEMINI_API_KEY not set — buddy uses built-in lines');
  if (!process.env.GOOGLE_MAPS_API_KEY) console.log('  GOOGLE_MAPS_API_KEY not set — the Map tab will ask for one');
  if (!process.env.ELEVENLABS_API_KEY) console.log('  ELEVENLABS_API_KEY not set — buddy uses the browser voice');
});
