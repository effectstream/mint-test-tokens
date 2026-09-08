import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = resolve(frontendRoot, '..');
const manifest = JSON.parse(await readFile(resolve(frontendRoot, 'client-artifacts.json'), 'utf8'));
const maxBuffer = 32 * 1024 * 1024;

const gitPrefix = process.env.MINT_SOURCE_GIT_DIR
  ? [`--git-dir=${process.env.MINT_SOURCE_GIT_DIR}`, `--work-tree=${repositoryRoot}`]
  : ['-C', repositoryRoot];

function git(args, options = {}) {
  return execFileSync('git', [...gitPrefix, ...args], {
    cwd: repositoryRoot,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function gitRevision(requested) {
  return git(['rev-parse', '--verify', `${requested}^{commit}`], { encoding: 'utf8' }).trim().toLowerCase();
}

const requestedBuildRevision = process.env.MINT_EXPECTED_RELEASE_SHA?.trim();
if (requestedBuildRevision && !/^[0-9a-f]{40}$/.test(requestedBuildRevision)) {
  throw new Error('MINT_EXPECTED_RELEASE_SHA must be a full lowercase Git SHA');
}
const checkoutRevision = gitRevision(requestedBuildRevision ?? 'HEAD');

async function listFiles(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  await visit(directory);
  return files.sort();
}

async function hashDirectory(directory) {
  const hash = createHash('sha256');
  for (const path of await listFiles(directory)) {
    hash.update(relative(directory, path));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function hashGitDirectory(revision, directory) {
  const resolved = gitRevision(revision);
  if (resolved !== revision) throw new Error(`Client artifact source revision is not exact: ${revision}`);
  const listed = git(['ls-tree', '-r', '--name-only', revision, '--', directory], { encoding: 'utf8' }).trim();
  const files = listed ? listed.split('\n').sort() : [];
  if (!files.length) throw new Error(`Client artifact source is missing ${directory} at ${revision}`);
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(relative(directory, path));
    hash.update('\0');
    hash.update(git(['show', `${revision}:${path}`]));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function assertIdentity(identity, label) {
  if (!identity || typeof identity !== 'object') throw new Error(`${label} must be an object`);
  if (!/^[0-9a-f]{40}$/.test(identity.sourceRevision ?? '')) throw new Error(`${label}.sourceRevision must be a full Git SHA`);
  if (typeof identity.compilerVersion !== 'string' || !identity.compilerVersion) throw new Error(`${label}.compilerVersion is required`);
  if (!/^[0-9a-f]{64}$/.test(identity.artifactSha256 ?? '')) throw new Error(`${label}.artifactSha256 must be a SHA-256`);
}

const generated = {};
for (const profile of ['v1', 'v2']) {
  generated[profile] = {};
  for (const privacy of ['shielded', 'unshielded']) {
    const label = `${profile}.${privacy}`;
    const identity = manifest[profile]?.[privacy];
    assertIdentity(identity, label);
    const relativeDirectory = `contracts/${profile}/managed/${privacy}`;
    const currentDigest = await hashDirectory(resolve(repositoryRoot, relativeDirectory));
    const pinnedDigest = hashGitDirectory(identity.sourceRevision, relativeDirectory);
    if (currentDigest !== identity.artifactSha256 || pinnedDigest !== identity.artifactSha256) {
      throw new Error(`${label} bundled, pinned and declared artifact digests must match`);
    }
    const compilerInfo = JSON.parse(await readFile(
      resolve(repositoryRoot, relativeDirectory, 'compiler/contract-info.json'),
      'utf8',
    ));
    if (compilerInfo['compiler-version'] !== identity.compilerVersion) {
      throw new Error(`${label} compiler version does not match bundled compiler metadata`);
    }
    const checkoutDigest = hashGitDirectory(checkoutRevision, relativeDirectory);
    if (checkoutDigest !== currentDigest) {
      throw new Error(`${label} current bundled artifacts are not tracked by build revision ${checkoutRevision}`);
    }
    generated[profile][privacy] = [
      identity,
      ...(checkoutRevision === identity.sourceRevision ? [] : [{
        sourceRevision: checkoutRevision,
        compilerVersion: identity.compilerVersion,
        artifactSha256: currentDigest,
      }]),
    ];
  }
}

const outputDirectory = resolve(frontendRoot, '.generated');
const output = resolve(outputDirectory, 'client-artifacts.json');
const temporary = `${output}.${process.pid}.tmp`;
await mkdir(outputDirectory, { recursive: true });
await writeFile(temporary, `${JSON.stringify(generated, null, 2)}\n`, 'utf8');
await rename(temporary, output);

console.log(`Verified bundled client artifact identities for build ${checkoutRevision}`);
