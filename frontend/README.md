# Test token directory

This Vite/React application is a static Cloudflare Pages site. It has no server
functions, API routes, or embedded deployment addresses. The selected
`metadata.{network}.json` file supplies the network identity, issuer addresses,
token IDs, metadata, and fixed faucet amounts at runtime.

## Install and build

Install each protocol profile separately. The separate lockfiles prevent the
WASM-backed Midnight 1.x and 2.x dependency graphs from being deduplicated into
an incompatible runtime.

```sh
npm ci
npm --prefix frontend ci
npm --prefix frontend/protocols/v1 ci
npm --prefix frontend/protocols/v2 ci
npm --prefix frontend run build
```

The output is `frontend/dist`. A public build contains
`metadata.preview.json`, `metadata.preprod.json`, and
`metadata.stagenet.json`, plus the exact v1/v2 issuer proving artifacts. It
never copies `metadata.undeployed.json`.

## Local development and deployment metadata

Vite reads metadata from `../metadata` by default. Point it at a deployment
tool's output directory without changing or rebuilding the application:

```sh
MINT_METADATA_DIR=/absolute/path/to/deployment/output npm --prefix frontend run dev
```

After a production build, use the included static server to test the same
runtime metadata behavior. The directory may gain or atomically replace
`metadata.undeployed.json` while the server remains running.

```sh
MINT_SITE_DIR=dist \
MINT_METADATA_DIR=/absolute/path/to/deployment/output \
MINT_SITE_PORT=14119 \
npm --prefix frontend run serve:local
```

Open `http://127.0.0.1:14119/?network=undeployed`. A missing local registry is
a real HTTP 404 and appears as unavailable in the interface.

## Cloudflare Pages

Configure Pages with the repository root as the working directory, the install
and build commands above, and `frontend/dist` as the build output directory.
The committed `_headers` file enables cross-origin reads for registry and
contract artifacts, revalidates registry files, and applies static security
headers. No Pages Function is required.

For a direct upload after a verified build:

```sh
npx --prefix frontend wrangler pages deploy frontend/dist --project-name mint-test-tokens
```

Publication must happen only after the public registry has verified on-chain
identities. The local `metadata.undeployed.json` file remains ignored and must
not be copied into `frontend/dist`.

## Wallet behavior

The site discovers DApp Connector API 4.x wallets. It compares the wallet's
reported network to the selected registry, delegates proving to the wallet,
submits the exact bytes returned by wallet balancing, and then watches the
wallet-selected indexer for finalization. Shielded user mints pass the
recipient coin and encryption keys to Midnight.js so the output is encrypted
for that recipient. Mint controls remain unavailable when metadata, wallet
capabilities, protocol adapter, or deployment identity is unavailable.
