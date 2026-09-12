import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';

export class RuntimeError extends Error {}

/** Held on a dedicated connection for the whole polling lifetime, including drain. */
export async function acquirePollingLock(pool: Pool, botId: number, onLost: () => void): Promise<() => void> {
  const client = await pool.connect();
  const lost = () => onLost();
  client.on('error', lost);
  client.on('end', lost);
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [`english-tutor:polling:${botId}`],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) throw new RuntimeError('Another instance of this bot is already running against this database. Stop it before starting a new one.');
  } catch (error) {
    client.removeListener('error', lost);
    client.removeListener('end', lost);
    client.release(true);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    client.removeListener('error', lost);
    client.removeListener('end', lost);
    // Destroy rather than return a session-level advisory lock to the pool.
    client.release(true);
  };
}

export function runtimePipePath(pid = process.pid): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\english-tutor-${pid}` : join(tmpdir(), `english-tutor-${pid}.sock`);
}

/** Local process control; no network listener or Telegram credentials are exposed. */
export async function startRuntimeControl(
  status: () => 'ready' | 'stopping',
  stop: () => void,
  endpoint = runtimePipePath(),
): Promise<() => Promise<void>> {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (input.length > 64) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      const command = input.trim();
      if (command === 'status') socket.end(`${status()}\n`);
      else if (command === 'stop') {
        socket.end('stopping\n');
        stop();
      } else socket.end('unknown\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); });
  });
  // Connection errors must not become uncaught process exceptions after startup.
  server.on('error', stop);
  return () => new Promise<void>((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close(error => error ? reject(error) : resolve());
  });
}

/** Only controlled messages and numeric/status codes are allowed into operational logs. */
export function runtimeFailure(error: unknown, stage: string): string {
  if (error instanceof RuntimeError) return error.message;
  const value = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (value.error_code === 409) return 'Telegram polling conflict: another process or deployment is receiving updates for this bot.';
  if (value.error_code === 401) return 'Telegram rejected BOT_TOKEN. Check the token in .env.';
  if (value.code === '28P01') return 'PostgreSQL authentication failed. Check DATABASE_URL.';
  if (value.code === 'ECONNREFUSED') return 'Connection refused. Check PostgreSQL and network availability.';
  return `Bot failed during ${stage}. Run npm run doctor; check the configuration and service availability.`;
}
