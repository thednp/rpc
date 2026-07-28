import { createServer, type IncomingMessage, type ServerResponse, type Server, type RequestListener } from 'node:http';

type SimpleHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void | Promise<void>;

interface Route {
  method: string;
  path: string;
  handler: SimpleHandler;
}

/**
 * Creates an Express compatible browser app
 * with similar API.
 */
export function H() {
  const middlewares: (Middleware | SimpleHandler)[] = [];
  const routes: Route[] = [];

  const app = {
    use(fn: Middleware | SimpleHandler) {
      middlewares.push(fn as Middleware);
      return app;
    },

    get(path: string, handler: SimpleHandler) {
      routes.push({ method: 'GET', path, handler });
      return app;
    },

    post(path: string, handler: SimpleHandler) {
      routes.push({ method: 'POST', path, handler });
      return app;
    },

    put(path: string, handler: SimpleHandler) {
      routes.push({ method: 'PUT', path, handler });
      return app;
    },

    delete(path: string, handler: SimpleHandler) {
      routes.push({ method: 'DELETE', path, handler });
      return app;
    },

    all(path: string, handler: SimpleHandler) {
      routes.push({ method: '*', path, handler });
      return app;
    },

    listen(port: number, callback?: () => void): Server {
      const handler: RequestListener = async (req, res) => {
        let i = 0;

        const send = (statusCode: number, body: string, contentType = 'text/plain') => {
          res.statusCode = statusCode;
          res.setHeader('Content-Type', contentType);
          res.end(body);
        };

        const next = async () => {
          // Always check at start - don't continue if already handled
          if (res.headersSent || res.writableEnded) {
            return;
          }
          
          if (i < middlewares.length) {
            const middleware = middlewares[i++];
            try {
              // Check BEFORE calling middleware if response already handled
              if (res.headersSent || res.writableEnded) {
                return;
              }
              
              // Check if handler has 3 params (req, res, next) - traditional middleware
              // or 2 params - simple handler
              const fn = middleware as (...args: unknown[]) => unknown;
              
              if (fn.length >= 3) {
                // Traditional middleware - callback-based, wrap in promise
                await new Promise<void>((resolve) => {
                  middleware(req, res, () => resolve());
                });
              } else {
                // Simple handler - await its result
                // const result = await (middleware as SimpleHandler)(req, res);
                // if (result instanceof Promise) {
                //   await result;
                // }
                await (middleware as SimpleHandler)(req, res);
              }

              // Check AFTER calling middleware if response was handled
              if (res.headersSent || res.writableEnded) {
                return; // Don't call next
              }

              // Auto-next only if response still not handled
              await next();
            } catch (err) {
              console.error('Middleware error:', err);
              send(500, 'Internal Server Error');
            }
          } else {
            // Try matching routes
            const route = routes.find(
              r => (r.method === '*' || r.method === req.method) &&
                   r.path === req.url
            );
            if (route) {
              try {
                await route.handler(req, res);
              } catch (err) {
                console.error('Route error:', err);
                send(500, 'Internal Server Error');
              }
            } else {
              send(404, 'Not Found');
            }
          }
        };

        await next();
      };

      const server = createServer(handler);
      server.listen(port, callback);
      return server;
    },
  };

  return app;
}

export type HServer = {
  use(fn: Middleware | SimpleHandler): HServer;
  get(path: string, handler: SimpleHandler): HServer;
  post(path: string, handler: SimpleHandler): HServer;
  put(path: string, handler: SimpleHandler): HServer;
  delete(path: string, handler: SimpleHandler): HServer;
  all(path: string, handler: SimpleHandler): HServer;
  listen(port: number, callback?: () => void): Server;
};
