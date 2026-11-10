import { createServer, type IncomingMessage, type Server } from 'node:http';

const API_PREFIX = '/sandbox/avazp/v5/cor/scs/';
const TOKEN_PATH = '/sandbox/avazp/oauth/token';

export interface RecordedRequest {
  method: string;
  /** Path after the API prefix, still percent-encoded. */
  path: string;
  body: unknown;
  headers: IncomingMessage['headers'];
}

type Reply = { status: number; body?: unknown };
type Route = (request: RecordedRequest) => Reply;

/** A local stand-in for Symplus, following the response shapes in its OpenAPI spec. */
export class FakeSymplus {
  requests: RecordedRequest[] = [];
  tokenRequests: { authorization?: string; body: string }[] = [];
  tokenCount = 0;
  validTokens = new Set<string>();
  routes = new Map<string, Route>();
  /** Replies queued for an endpoint, used before falling back to its route. */
  nextReplies = new Map<string, Reply[]>();
  private server?: Server;

  reset() {
    this.requests = [];
    this.tokenRequests = [];
    this.routes.clear();
    this.nextReplies.clear();
  }

  on(endpoint: string, route: Route) {
    this.routes.set(endpoint, route);
  }

  /** Makes the next calls to an endpoint return these replies, in order. */
  failNext(endpoint: string, ...replies: Reply[]) {
    this.nextReplies.set(endpoint, replies);
  }

  callsTo(endpoint: string) {
    return this.requests.filter((request) => request.path.split('/')[0] === endpoint);
  }

  revokeTokens() {
    this.validTokens.clear();
  }

  start(port: number) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const url = req.url ?? '';
        const respond = ({ status, body }: Reply) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(body === undefined ? undefined : JSON.stringify(body));
        };

        if (url === TOKEN_PATH) {
          this.tokenRequests.push({ authorization: req.headers.authorization, body: raw });
          this.tokenCount += 1;
          const token = `token-${this.tokenCount}`;
          this.validTokens.add(token);
          respond({ status: 200, body: { access_token: token, expires_in: 3600 } });
          return;
        }

        if (!this.validTokens.has(req.headers.authorization?.replace('Bearer ', '') ?? '')) {
          respond({ status: 401, body: { error: 'invalid_token' } });
          return;
        }

        const path = url.slice(API_PREFIX.length);
        const endpoint = path.split('/')[0] ?? '';
        const request: RecordedRequest = {
          method: req.method ?? '',
          path,
          body: raw ? JSON.parse(raw) : undefined,
          headers: req.headers,
        };
        this.requests.push(request);

        const queued = this.nextReplies.get(endpoint)?.shift();
        if (queued) {
          respond(queued);
          return;
        }

        const route = this.routes.get(endpoint);
        respond(route ? route(request) : { status: 204 });
      });
    });

    return new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
  }

  stop() {
    return new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
