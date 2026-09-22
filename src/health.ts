import { createServer } from 'node:http';

export type HealthSnapshot = { live: boolean; ready: boolean; database: boolean; polling: boolean; services: boolean };

/** Polling must have completed recently, including an empty getUpdates response. */
export class RuntimeHealth {
  private lastPoll = 0;
  private lastProgress = 0;
  private pending?: Promise<HealthSnapshot>;
  constructor(private readonly database: () => Promise<unknown>, private readonly running: () => boolean,
    private readonly services: () => boolean, private readonly now = Date.now) {}

  pollSucceeded(): void { this.lastPoll = this.now(); }
  updateCompleted(): void { this.lastProgress = this.now(); }

  snapshot(): Promise<HealthSnapshot> {
    return this.pending ??= this.probe().finally(() => { this.pending = undefined; });
  }

  private async probe(): Promise<HealthSnapshot> {
    let timer: NodeJS.Timeout | undefined;
    let database = false;
    try {
      await Promise.race([this.database(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('health timeout')), 5000);
      })]);
      database = true;
    } catch { /* Health responses contain only booleans, never connection details. */ }
    finally { clearTimeout(timer); }
    // Backpressure can delay polling while a bounded batch is processing. Require
    // either a poll within 2 minutes or actual update completion within 2 minutes,
    // and never accept a polling gap over 10 minutes.
    const pollAge = this.now() - this.lastPoll;
    const polling = this.lastPoll > 0 && pollAge < 600_000
      && (pollAge < 120_000 || this.now() - this.lastProgress < 120_000);
    const live = this.running() && database && polling;
    const services = this.services();
    return { live, ready: live && services, database, polling, services };
  }
}

export async function startHealthServer(health: RuntimeHealth, port = 8081): Promise<() => Promise<void>> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/live' && req.url !== '/ready')) { res.writeHead(404).end(); return; }
    void health.snapshot().then(state => {
      res.writeHead((req.url === '/live' ? state.live : state.ready) ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(state));
    }).catch(() => { res.writeHead(503).end(); });
  });
  server.requestTimeout = 8000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
