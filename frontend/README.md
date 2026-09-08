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

Before Vite starts, the artifact verifier reconstructs the stable public client
pins and the exact current Git `HEAD`, hashes those tracked issuer artifacts,
and emits the client identities bundled by the application. A local deployment
from that same checkout can atomically replace `metadata.undeployed.json`
without rebuilding; address, token ID and registry revision changes do not
change the client artifacts. After switching to a newer code checkout, rebuild
or restart Vite so its exact build-revision identity follows that checkout.
Registry-provided source revisions never become trusted client identities by
themselves.

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
contract artifacts, applies one `public, max-age=300, must-revalidate` policy to
registry files, and applies static security headers. The catch-all security rule
does not set caching, which prevents Cloudflare Pages from merging a second
`Cache-Control` value into metadata responses. No Pages Function is required.

### Verified release export

Do not upload `frontend/dist` from the working checkout. Docker gates build in
a disposable filesystem, while the host directory can still contain bytes from
an earlier commit. Export a release from an exact clean commit and keep its
manifest and provenance beside the publishable directory.

From the repository root, this reproduces the verified export procedure. It
uses `git archive`, so ignored host build output cannot enter the container.
The repository's Git object database is mounted read-only so the build can
reconstruct both historical compatibility pins and the explicit release commit;
Git data is never copied into `frontend/dist`.

```sh
release_sha="$(git rev-parse HEAD)"
release_tag="$(git rev-parse --short=7 "$release_sha")"
release_dir="/private/tmp/mint-test-tokens-release-$release_tag"
evidence_dir="$release_dir-evidence"
source_archive="/private/tmp/mint-test-tokens-source-$release_tag.tar"
git_dir="$(git rev-parse --absolute-git-dir)"

test -z "$(git status --porcelain)"
mkdir "$release_dir" "$evidence_dir"
git archive --format=tar --output="$source_archive" "$release_sha"

docker run --rm -i \
  -e RELEASE_SHA="$release_sha" \
  -e MINT_EXPECTED_RELEASE_SHA="$release_sha" \
  -e MINT_SOURCE_GIT_DIR=/input/repository.git \
  -v "$source_archive:/input/source.tar:ro" \
  -v "$git_dir:/input/repository.git:ro" \
  -v "$release_dir:/release" \
  -v "$evidence_dir:/evidence" \
  node:24.15.0-bookworm sh -eu <<'DOCKER'
mkdir /work
tar -xf /input/source.tar -C /work
cd /work

npm ci
npm --prefix frontend ci
npm --prefix frontend/protocols/v1 ci
npm --prefix frontend/protocols/v2 ci
npm --prefix frontend test
npm --prefix frontend run build

test ! -e frontend/dist/metadata.undeployed.json
cmp frontend/public/_headers frontend/dist/_headers
test -s frontend/dist/contract/v1/receiver/keys/receiveShieldedTokenFromIssuer.prover
test -s frontend/dist/contract/v1/receiver/keys/receiveUnshieldedTokenFromIssuer.verifier
test -s frontend/dist/contract/v2/receiver/zkir/receiveShieldedTokenFromIssuer.bzkir
test -s frontend/dist/contract/v2/receiver/zkir/receiveUnshieldedTokenFromIssuer.zkir
(cd frontend/dist && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > /tmp/build.SHA256SUMS
cp -a frontend/dist/. /release/
(cd /release && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > /evidence/SHA256SUMS
cmp /tmp/build.SHA256SUMS /evidence/SHA256SUMS

file_count="$(find /release -type f | wc -l | tr -d ' ')"
total_file_bytes="$(find /release -type f -printf '%s\n' | awk '{sum += $1} END {print sum}')"
largest_file="$(find /release -type f -printf '%s %P\n' | LC_ALL=C sort -nr | head -1)"
largest_bytes="$(printf '%s\n' "$largest_file" | cut -d ' ' -f 1)"
test "$file_count" -le 20000
test "$largest_bytes" -lt 26214400

cat > /evidence/PROVENANCE.txt <<EOF
source_commit=$RELEASE_SHA
builder=node:24.15.0-bookworm
test_result=passed
manifest=SHA256SUMS
file_count=$file_count
total_file_bytes=$total_file_bytes
largest_file=$largest_file
pages_file_count_limit=20000
pages_per_file_limit_bytes=26214400
export_matches_tested_build_sha256=true
EOF

(cd /release && sha256sum -c /evidence/SHA256SUMS)
DOCKER

rm "$source_archive"
```

Upload `$release_dir` itself. Keep `$evidence_dir` as the review record; do not
publish the sidecars as site assets. The source commit in `PROVENANCE.txt` and
every entry in `SHA256SUMS` must be checked before deployment. Never relabel an
existing artifact with a newer commit.

```sh
npx --prefix frontend wrangler pages deploy "$release_dir" --project-name mint-test-tokens
```

An explicitly labeled preview may contain different validated states for its
tracked public registries. In the current source, Preview and Stagenet are
`ready` with six verified active deployments each, while Preprod is
`unavailable` with empty deployments and no canonical addresses. Mint controls
follow the selected registry independently. Mint-ready publication for a
network requires verified on-chain identities and a ready semantic registry.
In every release, verify the deployed home page, all three public JSON files
byte-for-byte, wildcard JSON CORS, their single cache policy, representative
v1/v2 artifacts, and 404 responses for
`metadata.undeployed.json` and a missing artifact. The local undeployed file
must never appear in the release directory.

## Wallet behavior

The site discovers DApp Connector API 4.x wallets. It compares the wallet's
reported network to the selected registry, delegates proving to the wallet,
submits the exact bytes returned by wallet balancing, and then watches the
wallet-selected indexer for finalization. Shielded user mints pass the
recipient's full standard shielded address through the selected protocol codec;
the adapter derives its coin and encryption keys before wallet approval so the
output is encrypted for that recipient. Contract mints support the repository's compatible receiver
interface. The browser constructs one intent from the issuer's actual call
commitment and the receiver's `receive*FromIssuer` claim, retains the receiver
transaction offers, and proves both circuits before asking the wallet to submit
once. The unproven calls, commitment randomness, nonce and coin data stay in
browser memory and must not be logged. Mint controls remain unavailable when
metadata, wallet capabilities, protocol adapter, or deployment identity is
unavailable.
