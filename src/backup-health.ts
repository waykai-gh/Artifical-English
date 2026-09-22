import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Read only timestamps. The bot cannot access encrypted archives or backup keys. */
export async function backupHealthy(directory: string, now = Date.now()): Promise<boolean> {
  if (!directory) return true;
  try {
    const [backup, restored] = await Promise.all(['backup-success', 'restore-success'].map(async file => {
      const value = (await readFile(join(directory, file), 'utf8')).trim();
      if (!/^\d{10,}$/.test(value)) throw Error('Invalid backup timestamp');
      return Number(value) * 1000;
    }));
    return backup !== undefined && restored !== undefined && backup <= now && restored <= now
      && now - backup < 26 * 3600_000 && now - restored < 8 * 24 * 3600_000;
  } catch { return false; }
}
