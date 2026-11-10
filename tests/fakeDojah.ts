import { createServer, type Server } from 'node:http';

type Reply = { status: number; body: unknown };

/** A local stand-in for Dojah's NIN lookup, GET /api/v1/kyc/nin?nin=... */
export class FakeDojah {
  /** NINs Dojah knows, with the entity it returns for each. */
  records = new Map<string, Record<string, unknown>>();
  /** Every lookup, with the credentials it carried. */
  lookups: { nin: string | null; appId?: string; authorization?: string }[] = [];
  outage?: Reply;
  private server?: Server;

  reset() {
    this.records.clear();
    this.lookups = [];
    this.outage = undefined;
  }

  start(port: number) {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const nin = url.searchParams.get('nin');
      this.lookups.push({
        nin,
        appId: req.headers.appid as string | undefined,
        authorization: req.headers.authorization,
      });
      const reply = this.outage ?? this.route(url.pathname, nin);
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    return new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
  }

  private route(path: string, nin: string | null): Reply {
    if (path !== '/api/v1/kyc/nin') return { status: 404, body: { error: 'Not found' } };
    const entity = nin ? this.records.get(nin) : undefined;
    if (!entity) return { status: 400, body: { error: 'Wrong NIN Inputted' } };
    return { status: 200, body: { entity: { nin, image: '/9j/4AAQSkZJRg==', ...entity } } };
  }

  stop() {
    return new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
