import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Explicit routes keep the local server from exposing files outside the app.
const routes = new Map([
  ['/', ['public/index.html', 'text/html']],
  ['/index.html', ['public/index.html', 'text/html']],
  ['/styles.css', ['public/styles.css', 'text/css']],
  ['/app.js', ['public/app.js', 'text/javascript']],
  ['/movies.js', ['public/movies.js', 'text/javascript']],
  ['/sync.js', ['public/sync.js', 'text/javascript']],
  ['/sw.js', ['public/sw.js', 'text/javascript']],
  ['/vendor/pouchdb.min.js', ['node_modules/pouchdb/dist/pouchdb.min.js', 'text/javascript']]
]);

export function createServer() {
  return http.createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    const route = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (!route) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const body = await readFile(new URL(route[0], import.meta.url));
      res.writeHead(200, {
        'Content-Type': `${route[1]}; charset=utf-8`,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500).end('App file missing. Run npm install first.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8000);
  const server = createServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Movies: http://localhost:${port}`));
}
