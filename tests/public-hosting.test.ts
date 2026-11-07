// Deployment boundary checks. No external service or credentials; persistence uses an in-memory DB.
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/app/world.ts';
import { openDatabase } from '../src/db/database.ts';
import { json, type Req, type Res } from '../src/server/http.ts';
import { listenConfig } from '../src/server/listen-config.ts';
import { assertPublicData, publicGuard, PUBLIC_WINDOW_MS } from '../src/server/public-mode.ts';

const PUB = 'https://flexslot.example';
const world: Req = { method: 'POST', path: '/api/worlds', query: new URLSearchParams(), headers: {}, body: '{}' };

describe('external listener requires a separate public mock configuration', () => {
  it('keeps local defaults even when the environment has a platform PORT', () => {
    expect(listenConfig({ PORT: '10000' }, null)).toEqual({ host: '127.0.0.1', port: 8787 });
  });
  it('uses the platform port only in explicit public mode', () => {
    expect(listenConfig({ PORT: '10000', FLEXSLOT_HOST: '0.0.0.0', FLEXSLOT_DATA_DIR: '/var/data' }, PUB))
      .toEqual({ host: '0.0.0.0', port: 10000 });
  });
  it('refuses external binding without a public origin', () => {
    expect(() => listenConfig({ FLEXSLOT_HOST: '0.0.0.0', FLEXSLOT_DATA_DIR: '/var/data' }, null)).toThrow(/External/);
  });
  it('refuses external binding without an explicit data directory', () => {
    expect(() => listenConfig({ FLEXSLOT_HOST: '0.0.0.0' }, PUB)).toThrow(/dedicated/);
  });
  it('rejects arbitrary hosts and invalid ports', () => {
    expect(() => listenConfig({ FLEXSLOT_HOST: '::' }, PUB)).toThrow(/FLEXSLOT_HOST/);
    for (const port of ['0', '-1', '65536', '100.5', 'NaN', '']) {
      expect(() => listenConfig({ FLEXSLOT_PORT: port }, null), port).toThrow(/port/);
    }
  });
  it('retains an explicit local port override', () => {
    expect(listenConfig({ FLEXSLOT_PORT: '8888', PORT: '10000' }, PUB)).toEqual({ host: '127.0.0.1', port: 8888 });
  });
});

describe('public data boundary', () => {
  it('accepts an empty or mock-only database', () => {
    const db = openDatabase(':memory:');
    try {
      expect(() => assertPublicData(db)).not.toThrow();
      createWorld(db, Date.now(), { aiMode: 'MOCK', paymentMode: 'MOCK', payeeMerchantId: 'MOCK' });
      expect(() => assertPublicData(db)).not.toThrow();
    } finally { db.close(); }
  });
  it('refuses data from either connected mode', () => {
    for (const modes of [{ aiMode: 'MOCK', paymentMode: 'SANDBOX' }, { aiMode: 'VERTEX', paymentMode: 'MOCK' }] as const) {
      const db = openDatabase(':memory:');
      try {
        createWorld(db, Date.now(), { ...modes, payeeMerchantId: 'TEST' });
        expect(() => assertPublicData(db)).toThrow(/mock-only/);
      } finally { db.close(); }
    }
  });
});

describe('public creation budget', () => {
  it('opens again when the window expires while leaving existing routes usable', async () => {
    let now = 0;
    const guard = publicGuard(async () => json(201, {}), 1, { now: () => now });
    expect((await guard(world)).status).toBe(201);
    const limited = await guard(world);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('600');
    expect((await guard({ ...world, method: 'GET', path: '/api/config' })).status).toBe(201);
    now += PUBLIC_WINDOW_MS;
    expect((await guard(world)).status).toBe(201);
  });
  it('reserves capacity before awaiting a slow handler', async () => {
    let finish!: (res: Res) => void;
    const guard = publicGuard(() => new Promise<Res>((r) => { finish = r; }), 1);
    const first = guard(world);
    expect((await guard(world)).status).toBe(429);
    finish(json(201, {}));
    expect((await first).status).toBe(201);
    expect((await guard(world)).status).toBe(429);
  });
  it('returns reserved capacity after a rejected or thrown operation', async () => {
    let calls = 0;
    const guard = publicGuard(async () => {
      calls++;
      if (calls === 1) throw new Error('test failure');
      return json(calls === 2 ? 403 : 201, {});
    }, 1);
    await expect(guard(world)).rejects.toThrow('test failure');
    expect((await guard(world)).status).toBe(403);
    expect((await guard(world)).status).toBe(201);
    expect((await guard(world)).status).toBe(429);
  });
  it('uses saved world counts when a new guard is created after restart', async () => {
    const db = openDatabase(':memory:');
    let now = Date.now();
    const options = {
      now: () => now,
      recentCount: (since: number) => (db.prepare('SELECT count(*) AS n FROM worlds WHERE created_at > ?').get(since) as { n: number }).n,
    };
    const handle = async () => {
      createWorld(db, now, { aiMode: 'MOCK', paymentMode: 'MOCK', payeeMerchantId: 'MOCK' });
      return json(201, {});
    };
    try {
      expect((await publicGuard(handle, 1, options)(world)).status).toBe(201);
      const restarted = publicGuard(handle, 1, options);
      expect((await restarted(world)).status).toBe(429);
      now += PUBLIC_WINDOW_MS;
      expect((await restarted(world)).status).toBe(201);
    } finally { db.close(); }
  });
});
