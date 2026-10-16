import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { buildMcpServer } from './mcp/server.ts';
import { restApi } from './rest.ts';
import { bearer, type Runtime } from './runtime.ts';

/** HTTP surface: the desk's REST API and the MCP endpoint (stateless Streamable HTTP, spec 2026-07-28). */
export function buildApp(rt: Runtime, opts: { allowedOrigins?: string[] } = {}) {
  const app = new Hono();
  app.use(
    '/api/*',
    cors({
      origin: opts.allowedOrigins?.length ? opts.allowedOrigins : '*',
      allowHeaders: ['authorization', 'content-type'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    }),
  );
  app.route('/api', restApi(rt));

  const mcp = createMcpHandler(
    ({ authInfo }) => {
      const extra = authInfo?.extra as
        | { ctx: Parameters<typeof buildMcpServer>[1]; principal: Parameters<typeof buildMcpServer>[2] }
        | undefined;
      if (!extra) throw new Error('unauthenticated');
      return buildMcpServer(rt, extra.ctx, extra.principal);
    },
    { responseMode: 'json' },
  );

  app.all('/mcp', async (c) => {
    const token = bearer(c.req.header('authorization'));
    const grant = rt.grant(token);
    if (!grant) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Stare needs a desk token: open the desk and copy your MCP token.',
          },
          id: null,
        },
        401,
        { 'WWW-Authenticate': 'Bearer realm="stare"' },
      );
    }
    const ctx = await rt.ctx(grant.sbx);
    if (!ctx)
      return c.json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'This desk has expired.' }, id: null },
        401,
      );
    return mcp.fetch(c.req.raw, {
      authInfo: {
        token: token!,
        clientId: grant.principal.id,
        scopes: [],
        extra: { ctx, principal: grant.principal },
      },
    });
  });

  app.get('/', (c) => c.json({ name: 'stare', api: '/api', mcp: '/mcp', health: '/api/health' }));
  return app;
}
