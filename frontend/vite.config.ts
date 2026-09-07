import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { copyFile, cp, mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(here, '..');
const metadataDirectory = resolve(repositoryRoot, process.env.MINT_METADATA_DIR ?? 'metadata');
const metadataPath = /^\/metadata\.(preview|preprod|stagenet|undeployed)\.json$/;
const publicNetworks = ['preview', 'preprod', 'stagenet'] as const;
const protocolDirectories = {
  v1: resolve(here, 'protocols/v1'),
  v2: resolve(here, 'protocols/v2'),
} as const;
const artifactDirectories = {
  v1: resolve(repositoryRoot, 'contracts/v1/managed'),
  v2: resolve(repositoryRoot, 'contracts/v2/managed'),
} as const;

const artifactTypes = new Map([
  ['.bzkir', 'application/octet-stream'],
  ['.json', 'application/json; charset=utf-8'],
  ['.prover', 'application/octet-stream'],
  ['.verifier', 'application/octet-stream'],
  ['.zkir', 'application/octet-stream'],
]);

function profileRuntimeResolution() {
  return {
    name: 'profile-compact-runtime-resolution',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (source !== '@midnight-ntwrk/compact-runtime' || !importer) return null;
      const profile = importer.includes(`${sep}contracts${sep}v1${sep}`)
        ? 'v1'
        : importer.includes(`${sep}contracts${sep}v2${sep}`)
          ? 'v2'
          : null;
      return profile
        ? resolve(protocolDirectories[profile], 'node_modules/@midnight-ntwrk/compact-runtime/dist/index.js')
        : null;
    },
  };
}

function contractArtifacts() {
  return {
    name: 'mint-test-token-contract-artifacts',
    configureServer(server: { middlewares: { use: (handler: (request: { method?: string; url?: string }, response: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string | Buffer) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((request, response, next) => {
        const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
        const match = /^\/contract\/(v1|v2)\/(shielded|unshielded|receiver)\/(.+)$/.exec(pathname);
        if (!match) {
          next();
          return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET, HEAD');
          response.end();
          return;
        }
        const root = resolve(artifactDirectories[match[1] as 'v1' | 'v2'], match[2]);
        const file = resolve(root, match[3]);
        if (file !== root && !file.startsWith(`${root}${sep}`)) {
          response.statusCode = 400;
          response.end('Invalid artifact path');
          return;
        }
        void readFile(file).then((contents) => {
          response.statusCode = 200;
          response.setHeader('Content-Type', artifactTypes.get(extname(file)) ?? 'application/octet-stream');
          response.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
          response.setHeader('X-Content-Type-Options', 'nosniff');
          response.end(request.method === 'HEAD' ? undefined : contents);
        }).catch((error: NodeJS.ErrnoException) => {
          response.statusCode = error.code === 'ENOENT' ? 404 : 500;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.end(request.method === 'HEAD' ? undefined : error.code === 'ENOENT' ? 'Artifact not found' : 'Artifact read failed');
        });
      });
    },
    async closeBundle() {
      const output = resolve(here, 'dist/contract');
      await Promise.all((['v1', 'v2'] as const).flatMap((profile) =>
        (['shielded', 'unshielded', 'receiver'] as const).map(async (privacy) => {
          const destination = resolve(output, profile, privacy);
          await mkdir(destination, { recursive: true });
          await cp(resolve(artifactDirectories[profile], privacy), destination, { recursive: true });
        }),
      ));
    },
  };
}

function metadataAssets() {
  return {
    name: 'mint-test-token-metadata',
    configureServer(server: { middlewares: { use: (handler: (request: { method?: string; url?: string }, response: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string | Buffer) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        const match = metadataPath.exec(pathname);
        if (!match) {
          next();
          return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET, HEAD');
          response.end();
          return;
        }

        const file = resolve(metadataDirectory, `metadata.${match[1]}.json`);
        void readFile(file)
          .then((contents) => {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Access-Control-Allow-Origin', '*');
            response.setHeader('Cache-Control', 'no-cache, must-revalidate');
            response.end(request.method === 'HEAD' ? undefined : contents);
          })
          .catch((error: NodeJS.ErrnoException) => {
            response.statusCode = error.code === 'ENOENT' ? 404 : 500;
            response.setHeader('Content-Type', 'text/plain; charset=utf-8');
            response.end(request.method === 'HEAD' ? undefined : error.code === 'ENOENT' ? 'Metadata not found' : 'Metadata read failed');
          });
      });
    },
    async closeBundle() {
      const output = resolve(here, 'dist');
      await Promise.all(publicNetworks.map((network) => copyFile(
        resolve(metadataDirectory, `metadata.${network}.json`),
        resolve(output, `metadata.${network}.json`),
      )));
    },
  };
}

export default defineConfig({
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      assert: resolve(here, 'node_modules/assert/build/assert.js'),
      'isomorphic-ws': resolve(here, 'src/shims/isomorphic-ws.ts'),
    },
  },
  plugins: [profileRuntimeResolution(), react(), wasm(), metadataAssets(), contractArtifacts()],
  optimizeDeps: {
    exclude: [
      '@midnight-ntwrk/compact-js',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/ledger-v8',
      '@midnightntwrk/ledger-v9',
      '@midnight-ntwrk/midnight-js-contracts',
      '@midnight-ntwrk/midnight-js-types',
    ],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'esnext',
  },
  worker: { format: 'es' },
  assetsInclude: ['**/*.wasm'],
  server: {
    host: '0.0.0.0',
    fs: { allow: ['..'] },
  },
});
