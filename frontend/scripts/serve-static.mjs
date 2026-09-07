import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const frontendRoot = resolve(here, '..');
const siteDirectory = resolve(frontendRoot, process.env.MINT_SITE_DIR ?? 'dist');
const metadataDirectory = resolve(frontendRoot, process.env.MINT_METADATA_DIR ?? '../metadata');
const port = Number.parseInt(process.env.MINT_SITE_PORT ?? '14119', 10);
const metadataPattern = /^\/metadata\.(preview|preprod|stagenet|undeployed)\.json$/;

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

function sendFile(request, response, file, headers = {}, statusCode = 200) {
  void stat(file).then((details) => {
    if (!details.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
    response.statusCode = statusCode;
    response.setHeader('Content-Type', contentTypes.get(extname(file)) ?? 'application/octet-stream');
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  }).catch((error) => {
    if (!response.headersSent) {
      response.statusCode = error.code === 'ENOENT' ? 404 : 500;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Unable to read file');
    }
  });
}

const server = createServer((request, response) => {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, HEAD');
    response.end();
    return;
  }

  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const metadataMatch = metadataPattern.exec(pathname);
  if (metadataMatch) {
    sendFile(request, response, resolve(metadataDirectory, `metadata.${metadataMatch[1]}.json`), {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidate = resolve(siteDirectory, relative);
  if (candidate !== siteDirectory && !candidate.startsWith(`${siteDirectory}${sep}`)) {
    response.statusCode = 400;
    response.end('Invalid path');
    return;
  }

  void access(candidate).then(() => sendFile(request, response, candidate, {
    'Cache-Control': extname(candidate) ? 'public, max-age=0, must-revalidate' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })).catch(() => {
    if (extname(relative) || pathname.startsWith('/metadata.')) {
      sendFile(request, response, resolve(siteDirectory, '404.html'), { 'Cache-Control': 'no-cache' }, 404);
      return;
    }
    sendFile(request, response, resolve(siteDirectory, 'index.html'), { 'Cache-Control': 'no-cache' });
  });
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`Static token site: http://127.0.0.1:${port}\n`);
  process.stdout.write(`Metadata directory: ${metadataDirectory}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
