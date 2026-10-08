import { describe, expect, it } from 'vitest';
import { Cockpit, CockpitError } from './cockpit.ts';
import { HEALTH, PROJECTS, fakeCockpit, project } from './mcp.testkit.ts';

const PORTS = [4321, 4330] as const;

describe('Cockpit — finding the running cez serve', () => {
  it('uses an explicit url when it answers as a cezar cockpit', async () => {
    const fake = fakeCockpit({ ports: [4999] });
    const cockpit = new Cockpit({ url: 'http://127.0.0.1:4999/', cwd: '/repos/boot', fetch: fake.fetch, ports: PORTS });
    expect(await cockpit.url()).toBe('http://127.0.0.1:4999');
  });

  it('names an explicit url that does not answer, instead of discovering another cockpit', async () => {
    const fake = fakeCockpit({ ports: [4321] });
    const cockpit = new Cockpit({ url: 'http://127.0.0.1:4999', cwd: '/repos/boot', fetch: fake.fetch, ports: PORTS });
    await expect(cockpit.url()).rejects.toThrow(/no cezar cockpit at http:\/\/127\.0\.0\.1:4999/);
  });

  it('finds a cockpit that moved off 4321 (pickPort takes the next free port)', async () => {
    const fake = fakeCockpit({ ports: [4323] });
    const cockpit = new Cockpit({ cwd: '/repos/boot', fetch: fake.fetch, ports: PORTS });
    expect(await cockpit.url()).toBe('http://127.0.0.1:4323');
  });

  it('reports no cockpit with the scanned range and the fix', async () => {
    const fake = fakeCockpit({ ports: [] });
    const cockpit = new Cockpit({ cwd: '/repos/boot', fetch: fake.fetch, ports: PORTS });
    await expect(cockpit.url()).rejects.toThrow('no cezar cockpit found on 127.0.0.1:4321–4330 — start it with `cez serve`');
  });

  it('skips a port whose /health is not a cezar cockpit', async () => {
    const fake = fakeCockpit({ ports: [4321, 4324], health: { 4321: { hello: 'world' } } });
    const cockpit = new Cockpit({ cwd: '/repos/boot', fetch: fake.fetch, ports: PORTS });
    expect(await cockpit.url()).toBe('http://127.0.0.1:4324');
  });

  it('prefers, among several cockpits, the one serving the cwd’s project', async () => {
    const other = { ...PROJECTS, projects: [project('elsewhere', '/elsewhere')] };
    const fake = fakeCockpit({
      ports: [4321, 4325],
      routes: {
        'GET /api/v1/projects': ({ url }) => ({ body: url.port === '4321' ? other : PROJECTS }),
      },
    });
    const cockpit = new Cockpit({ cwd: '/repos/api/src', fetch: fake.fetch, ports: PORTS });
    expect(await cockpit.url()).toBe('http://127.0.0.1:4325');
  });

  it('falls back to the lowest port when no cockpit serves the cwd', async () => {
    const fake = fakeCockpit({ ports: [4326, 4322] });
    const cockpit = new Cockpit({ cwd: '/nowhere', fetch: fake.fetch, ports: PORTS });
    expect(await cockpit.url()).toBe('http://127.0.0.1:4322');
  });
});

describe('Cockpit — requests', () => {
  it('relays a route’s {error} with its status', async () => {
    const fake = fakeCockpit({ routes: { 'POST /api/v1/runs/r1/cancel': () => ({ status: 409, body: { error: 'run already finished' } }) } });
    const cockpit = new Cockpit({ cwd: '/repos/boot', fetch: fake.fetch, ports: PORTS });
    await expect(cockpit.post('/api/v1/runs/r1/cancel', {})).rejects.toThrow(new CockpitError('409: run already finished'));
  });

  it('forgets a cockpit that stopped answering and finds it again on its new port', async () => {
    const ports = new Set([4321]);
    const base = fakeCockpit({ ports: [4321, 4327], routes: { 'GET /api/v1/x': () => ({ body: { ok: true } }) } });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!ports.has(Number(url.port))) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      return base.fetch(input, init);
    }) as typeof fetch;
    const cockpit = new Cockpit({ cwd: '/repos/boot', fetch: fetchImpl, ports: PORTS });
    expect(await cockpit.get('/api/v1/x')).toEqual({ ok: true });
    ports.clear();
    ports.add(4327); // restarted elsewhere
    await expect(cockpit.get('/api/v1/x')).rejects.toThrow(/unreachable at http:\/\/127\.0\.0\.1:4321.*ECONNREFUSED/);
    expect(await cockpit.get('/api/v1/x')).toEqual({ ok: true });
    expect(await cockpit.url()).toBe('http://127.0.0.1:4327');
  });

  it('accepts a health body from a newer or older cockpit as long as it is cezar', async () => {
    const fake = fakeCockpit({ health: { 4321: { ...HEALTH, somethingNew: 1 } } });
    const cockpit = new Cockpit({ cwd: '/repos/boot', fetch: fake.fetch, ports: PORTS });
    expect(await cockpit.url()).toBe('http://127.0.0.1:4321');
  });
});
