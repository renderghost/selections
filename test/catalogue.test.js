import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { catalogueEtag, createCatalogue } from '../src/catalogue.js';
import { CatalogueUnavailableError, TidalAuthError } from '../src/errors.js';
import { fakeReporter, silentLogger } from './helpers.js';

const record = (id, rev = 'r1') => ({ id, rev, title: `Playlist ${id}` });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup({ load, snapshotPath = null, ttlMs = 1000 } = {}) {
  let now = 1_000_000;
  const reporter = fakeReporter();
  const catalogue = createCatalogue({ load, ttlMs, snapshotPath, logger: silentLogger, reporter, now: () => now, minRetryMs: 100 });
  return { catalogue, reporter, advance: (ms) => (now += ms) };
}

describe('catalogueEtag', () => {
  it('depends only on ids and revisions', () => {
    assert.equal(catalogueEtag([record('a'), record('b')]), catalogueEtag([record('a'), record('b')]));
    assert.notEqual(catalogueEtag([record('a')]), catalogueEtag([record('a', 'r2')]));
  });
});

describe('catalogue', () => {
  let dir;
  before(async () => (dir = await mkdtemp(join(tmpdir(), 'selections-'))));
  after(() => rm(dir, { recursive: true, force: true }));

  it('loads on first use and shares one load between concurrent requests', async () => {
    let loads = 0;
    const { catalogue } = setup({ load: async () => (loads++, [record('a')]) });
    const [one, two] = await Promise.all([catalogue.get(), catalogue.get()]);
    assert.equal(loads, 1);
    assert.equal(one, two);
    assert.deepEqual(one.manifest, [['a', 'r1']]);
    assert.equal(one.byId.get('a').title, 'Playlist a');
  });

  it('serves stale data immediately while refreshing in the background', async () => {
    let version = 1;
    const { catalogue, advance } = setup({ load: async () => [record('a', `r${version}`)] });
    await catalogue.get();
    version = 2;
    advance(1001);
    const stale = await catalogue.get();
    assert.equal(stale.byId.get('a').rev, 'r1');
    await settle();
    assert.equal((await catalogue.get()).byId.get('a').rev, 'r2');
  });

  it('keeps serving the last good copy when TIDAL fails, and backs off', async () => {
    let fail = false;
    let loads = 0;
    const { catalogue, advance, reporter } = setup({
      load: async () => {
        loads++;
        if (fail) throw new Error('TIDAL down');
        return [record('a')];
      },
    });
    await catalogue.get();
    fail = true;
    advance(1001);
    assert.equal((await catalogue.get()).records.length, 1);
    await settle();
    assert.equal(loads, 2);
    assert.equal(catalogue.status().consecutiveFailures, 1);
    assert.equal(reporter.calls.exception[0].options.level, 'warn');

    await catalogue.get(); // Within the back-off window: no new attempt.
    await settle();
    assert.equal(loads, 2);
    advance(101);
    await catalogue.get();
    await settle();
    assert.equal(loads, 3);
  });

  it('reports credential problems as errors even while serving stale data', async () => {
    let fail = false;
    const { catalogue, advance, reporter } = setup({
      load: async () => {
        if (fail) throw new TidalAuthError('denied');
        return [record('a')];
      },
    });
    await catalogue.get();
    fail = true;
    advance(1001);
    await catalogue.get();
    await settle();
    assert.equal(reporter.calls.exception[0].options.level, 'error');
  });

  it('is unavailable (503) with nothing to serve, with a Retry-After hint', async () => {
    const { catalogue } = setup({ load: async () => Promise.reject(new Error('down')) });
    await assert.rejects(catalogue.get(), (error) => {
      assert.ok(error instanceof CatalogueUnavailableError);
      assert.equal(error.status, 503);
      assert.ok(error.retryAfterSeconds >= 5);
      return true;
    });
    assert.equal(catalogue.status().ready, false);
  });

  it('persists a snapshot and restores it on restart', async () => {
    const snapshotPath = join(dir, 'nested', 'snapshot.json');
    const first = setup({ load: async () => [record('a'), record('b')], snapshotPath });
    await first.catalogue.get();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(JSON.parse(await readFile(snapshotPath, 'utf8')).records.length, 2);

    const second = setup({ load: () => new Promise(() => {}), snapshotPath }); // TIDAL never answers.
    await second.catalogue.start();
    const snapshot = await second.catalogue.get();
    assert.deepEqual(snapshot.records.map((r) => r.id), ['a', 'b']);
  });

  it('ignores corrupt or outdated snapshots', async () => {
    const snapshotPath = join(dir, 'bad.json');
    for (const content of ['{not json', JSON.stringify({ version: 0, records: [] }), JSON.stringify({ version: 1, records: [{ id: 1 }] })]) {
      await writeFile(snapshotPath, content);
      const { catalogue } = setup({ load: async () => [record('fresh')], snapshotPath });
      await catalogue.start();
      assert.equal((await catalogue.get()).records[0].id, 'fresh');
    }
  });
});
