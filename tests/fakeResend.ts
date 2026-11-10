import { createServer, type Server } from 'node:http';

export interface SentEmail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
  authorization?: string;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

/** A local stand-in for Resend's send endpoint. */
export class FakeResend {
  sent: SentEmail[] = [];
  /** When set, every request gets this reply instead of being sent. */
  outage?: Reply;
  private server?: Server;

  reset() {
    this.sent = [];
    this.outage = undefined;
  }

  to(address: string) {
    return this.sent.filter((email) => email.to.includes(address));
  }

  /** The code in the latest email to an address. */
  codeFor(address: string) {
    const code = this.to(address)
      .at(-1)
      ?.text.match(/\b\d{6}\b/)?.[0];
    if (!code) throw new Error(`No code was emailed to ${address}`);
    return code;
  }

  start(port: number) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const reply: Reply = this.outage ?? { status: 200, body: { id: `re_${this.sent.length}` } };
        if (!this.outage) {
          this.sent.push({
            ...(JSON.parse(Buffer.concat(chunks).toString()) as SentEmail),
            idempotencyKey: req.headers['idempotency-key'] as string | undefined,
            authorization: req.headers.authorization,
          });
        }
        res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
        res.end(JSON.stringify(reply.body));
      });
    });
    return new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
  }

  stop() {
    return new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
