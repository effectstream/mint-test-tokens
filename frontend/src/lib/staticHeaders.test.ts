import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface HeaderRule {
  pattern: string;
  headers: Map<string, string>;
}

function rulesFor(source: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      rules.push({ pattern: line.trim(), headers: new Map() });
      continue;
    }
    const separator = line.indexOf(':');
    if (separator < 0 || !rules.length) throw new Error(`Invalid _headers line: ${line}`);
    rules.at(-1)?.headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return rules;
}

function matches(pattern: string, path: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`).test(path);
}

describe('Cloudflare Pages static headers', () => {
  it('assigns exactly one deterministic cache policy to each static resource class', async () => {
    const path = resolve(process.cwd(), 'public/_headers');
    const rules = rulesFor(await readFile(path, 'utf8'));
    const cachePolicies = (resource: string) => rules
      .filter((rule) => matches(rule.pattern, resource))
      .map((rule) => rule.headers.get('cache-control'))
      .filter((value): value is string => value !== undefined);
    const duplicateHeaders = (resource: string) => {
      const counts = new Map<string, number>();
      for (const rule of rules.filter((candidate) => matches(candidate.pattern, resource))) {
        for (const name of rule.headers.keys()) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return [...counts].filter(([, count]) => count > 1).map(([name]) => name);
    };

    const cases = [
      ['/metadata.preview.json', 'public, max-age=300, must-revalidate'],
      ['/contract/v1/shielded/keys/mint.prover', 'public, max-age=3600, must-revalidate'],
      ['/assets/index-abc.js', 'public, max-age=31536000, immutable'],
      ['/', 'public, max-age=0, must-revalidate'],
      ['/index.html', 'public, max-age=0, must-revalidate'],
    ] as const;
    for (const [resource, cachePolicy] of cases) {
      expect(cachePolicies(resource)).toEqual([cachePolicy]);
      expect(duplicateHeaders(resource)).toEqual([]);
    }
  });
});
