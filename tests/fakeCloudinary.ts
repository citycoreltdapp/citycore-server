import { createServer, type Server } from 'node:http';

type Reply = { status: number; body: unknown };

/** A local stand-in for Cloudinary's upload API, which the real SDK talks to during tests. */
export class FakeCloudinary {
  /** The delivery URL of every file currently stored. */
  files = new Set<string>();
  /** When set, every request gets this reply. */
  outage?: Reply;
  private server?: Server;

  reset() {
    this.files.clear();
    this.outage = undefined;
  }

  start(port: number) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('latin1');
        const { status, body } = this.outage ?? this.route(req.url ?? '', raw);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    return new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
  }

  private route(path: string, raw: string): Reply {
    const match = /^\/v1_1\/([^/]+)\/(image|raw)\/(upload|destroy)$/.exec(path);
    const publicId = /name="public_id"\r\n\r\n([^\r]+)\r\n/.exec(raw)?.[1];
    if (!match || !publicId || !raw.includes('name="signature"')) {
      return { status: 404, body: { error: { message: 'Not found' } } };
    }
    const [, cloud, resourceType, action] = match as unknown as [string, string, string, string];
    const prefix = `https://res.cloudinary.com/${cloud}/${resourceType}/upload/v1/${publicId}`;
    const url = resourceType === 'image' ? `${prefix}.png` : prefix;

    if (action === 'upload') {
      this.files.add(url);
      return { status: 200, body: { public_id: publicId, secure_url: url } };
    }
    return { status: 200, body: { result: this.files.delete(url) ? 'ok' : 'not found' } };
  }

  stop() {
    return new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
