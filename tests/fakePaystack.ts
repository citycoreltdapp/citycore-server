import { createServer, type Server } from 'node:http';

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown>;
  authorization?: string;
}

type Reply = { status: number; body: unknown };

/** A local stand-in for Paystack, following the response shapes in its OpenAPI spec. */
export class FakePaystack {
  requests: Recorded[] = [];
  /** What verify returns for each reference. Anything else gets "not found". */
  transactions = new Map<string, Record<string, unknown>>();
  /** When set, every request gets this reply. */
  outage?: Reply;
  private server?: Server;

  reset() {
    this.requests = [];
    this.transactions.clear();
    this.outage = undefined;
  }

  /** Sets the answer Paystack gives when asked about a reference. */
  setTransaction(reference: string, data: Record<string, unknown>) {
    this.transactions.set(reference, {
      id: 1001,
      reference,
      currency: 'NGN',
      channel: 'card',
      paid_at: '2026-11-06T10:00:00.000Z',
      fees: 150,
      gateway_response: 'Successful',
      ...data,
    });
  }

  callsTo(path: string) {
    return this.requests.filter((request) => request.path.startsWith(path));
  }

  start(port: number) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const path = req.url ?? '';
        const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        this.requests.push({
          method: req.method ?? '',
          path,
          body,
          authorization: req.headers.authorization,
        });

        const { status, body: reply } = this.outage ?? this.route(path, body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    return new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
  }

  private route(path: string, body: Record<string, unknown>): Reply {
    if (path === '/transaction/initialize') {
      return {
        status: 200,
        body: {
          status: true,
          message: 'Authorization URL created',
          data: {
            authorization_url: `https://checkout.paystack.com/${body.reference as string}`,
            access_code: 'ACCESS',
            reference: body.reference,
          },
        },
      };
    }
    if (path.startsWith('/transaction/verify/')) {
      const data = this.transactions.get(decodeURIComponent(path.split('/').pop() ?? ''));
      return data
        ? { status: 200, body: { status: true, message: 'Verification successful', data } }
        : { status: 400, body: { status: false, message: 'Transaction reference not found' } };
    }
    if (path === '/dedicated_account/assign') {
      return {
        status: 200,
        body: { status: true, message: 'Assign dedicated account in progress' },
      };
    }
    if (path.startsWith('/dedicated_account/requery')) {
      return { status: 200, body: { status: true, message: 'Requery in progress' } };
    }
    return { status: 404, body: { status: false, message: 'Not found' } };
  }

  stop() {
    return new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
