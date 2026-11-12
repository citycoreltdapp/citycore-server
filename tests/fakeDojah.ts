import { createServer, type Server } from 'node:http';

type Reply = { status: number; body: unknown };

export class FakeDojah {
  records = new Map<string, Record<string, unknown>>();
  bvns = new Map<string, Record<string, unknown>>();
  companies = new Map<string, Record<string, unknown>>();
  tins = new Map<string, string>();
  accounts = new Map<string, string>();
  lookups: { path: string; nin: string | null; appId?: string; authorization?: string }[] = [];
  outage?: Reply;
  private server?: Server;

  reset() {
    this.records.clear();
    this.bvns.clear();
    this.companies.clear();
    this.tins.clear();
    this.accounts.clear();
    this.lookups = [];
    this.outage = undefined;
  }

  start(port: number) {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      this.lookups.push({
        path: url.pathname,
        nin: url.searchParams.get('nin'),
        appId: req.headers.appid as string | undefined,
        authorization: req.headers.authorization,
      });
      const reply = this.outage ?? this.route(url);
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    return new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
  }

  private route(url: URL): Reply {
    const query = (key: string) => url.searchParams.get(key) ?? '';
    const company = `${query('company_type')}:${query('rc_number')}`;
    const found = (entity: unknown): Reply =>
      entity ? { status: 200, body: { entity } } : { status: 404, body: { error: 'Not found' } };

    switch (url.pathname) {
      case '/api/v1/kyc/nin': {
        const entity = this.records.get(query('nin'));
        if (!entity) return { status: 400, body: { error: 'Wrong NIN Inputted' } };
        return found({ nin: query('nin'), image: '/9j/4AAQSkZJRg==', ...entity });
      }
      case '/api/v1/kyc/bvn/full':
        return found(this.bvns.get(query('bvn')));
      case '/api/v1/kyc/cac/advance':
        return found(this.companies.get(company));
      case '/api/v1/kyc/cac/tin': {
        const tin = this.tins.get(company);
        return found(tin && { tax_id: tin, rc_number: query('rc_number') });
      }
      case '/api/v1/general/account': {
        const name = this.accounts.get(`${query('bank_code')}:${query('account_number')}`);
        return found(name && { account_number: query('account_number'), account_name: name });
      }
      default:
        return { status: 404, body: { error: 'Not found' } };
    }
  }

  stop() {
    return new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
