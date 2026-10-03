import { readFile } from 'node:fs/promises';
import { generateChatKey } from './config.js';

try {
  process.stdout.write(await readFile(await generateChatKey(), 'utf8'));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to generate CHAT_API_KEY_FILE');
  process.exitCode = 1;
}
