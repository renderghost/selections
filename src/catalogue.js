import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CatalogueUnavailableError, TidalAuthError } from './errors.js';

// Bump when the record shape changes, so old snapshots on disk are ignored.
const SNAPSHOT_VERSION = 1;

/** Content-derived version of the whole catalogue: identical data ⇒ identical etag, across restarts. */
export function catalogueEtag(records) {
  const hash = createHash('sha256');
  for (const record of records) hash.update(`${record.id}:${record.rev}\n`);
  return hash.digest('base64url').slice(0, 16);
}

function buildSnapshot(records, fetchedAt) {
  return {
    records,
    byId: new Map(records.map((record) => [record.id, record])),
    manifest: records.map((record) => [record.id, record.rev]),
    etag: catalogueEtag(records),
    fetchedAt,
  };
}

const isValidRecord = (record) => typeof record?.id === 'string' && typeof record?.rev === 'string' && typeof record?.title === 'string';

/**
 * The server's copy of the playlists.
 *
 * - Serves from memory; once older than `ttlMs`, the next request triggers a
 *   background refresh and is answered immediately with the current copy.
 * - Persists a last-known-good snapshot to disk, so restarts are instant and
 *   a TIDAL outage doesn't take the site down.
 * - Backs off exponentially while TIDAL is failing.
 */
export function createCatalogue({ load, ttlMs, snapshotPath, logger, reporter, now = Date.now, minRetryMs = 30_000 }) {
  let snapshot = null;
  let refreshing = null;
  let failures = 0;
  let lastError = null;
  let nextAttemptAt = 0;

  async function persist(snap) {
    if (!snapshotPath) return;
    const tmp = `${snapshotPath}.${process.pid}.tmp`;
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(tmp, JSON.stringify({ version: SNAPSHOT_VERSION, fetchedAt: snap.fetchedAt, records: snap.records }));
    await rename(tmp, snapshotPath);
  }

  async function restore() {
    if (!snapshotPath) return false;
    let raw;
    try {
      raw = await readFile(snapshotPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn({ err }, 'Could not read playlist snapshot');
      return false;
    }
    try {
      const data = JSON.parse(raw);
      if (data?.version !== SNAPSHOT_VERSION || !Array.isArray(data.records) || !data.records.every(isValidRecord)) {
        logger.info('Ignoring playlist snapshot from an older version');
        return false;
      }
      snapshot = buildSnapshot(data.records, Number(data.fetchedAt) || 0);
      logger.info({ count: snapshot.records.length, ageSeconds: ageSeconds() }, 'Restored playlist snapshot from disk');
      return true;
    } catch (err) {
      logger.warn({ err }, 'Playlist snapshot is corrupt; ignoring it');
      return false;
    }
  }

  const ageSeconds = () => (snapshot ? Math.round((now() - snapshot.fetchedAt) / 1000) : null);
  const isStale = () => !snapshot || now() - snapshot.fetchedAt >= ttlMs;

  function refresh() {
    refreshing ??= (async () => {
      const startedAt = now();
      try {
        const records = await load();
        const changed = snapshot?.etag !== catalogueEtag(records);
        snapshot = buildSnapshot(records, now());
        failures = 0;
        lastError = null;
        nextAttemptAt = 0;
        logger.info({ count: records.length, etag: snapshot.etag, changed, ms: now() - startedAt }, 'Playlist catalogue refreshed');
        persist(snapshot).catch((err) => logger.warn({ err }, 'Could not save playlist snapshot'));
        return snapshot;
      } catch (error) {
        failures++;
        lastError = { code: error.code ?? 'UNKNOWN', message: error.message, at: new Date(now()).toISOString() };
        nextAttemptAt = now() + Math.min(minRetryMs * 2 ** (failures - 1), ttlMs);
        // Credentials problems never fix themselves; a blip while we still have data is just a warning.
        const serious = !snapshot || error instanceof TidalAuthError || failures >= 3;
        reporter.exception(error, {
          level: serious ? 'error' : 'warn',
          msg: snapshot ? 'Could not refresh playlists from TIDAL; still serving the previous copy' : 'Could not load playlists from TIDAL',
          tags: { component: 'catalogue' },
          extra: { failures, retryInSeconds: Math.round((nextAttemptAt - now()) / 1000) },
        });
        throw error;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  const unavailable = (cause) => {
    const error = new CatalogueUnavailableError(cause);
    error.retryAfterSeconds = Math.max(5, Math.ceil((nextAttemptAt - now()) / 1000));
    return error;
  };

  return {
    /** Restores the disk snapshot and starts fetching fresh data without waiting for it. */
    async start() {
      await restore();
      if (isStale()) refresh().catch(() => {});
    },

    /** The current snapshot. Only waits for TIDAL when there is nothing to serve yet. */
    async get() {
      if (snapshot) {
        if (isStale() && !refreshing && now() >= nextAttemptAt) refresh().catch(() => {});
        return snapshot;
      }
      if (!refreshing && now() < nextAttemptAt) throw unavailable(lastError);
      try {
        return await (refreshing ?? refresh());
      } catch (error) {
        throw unavailable(error);
      }
    },

    /** The current snapshot or null, without waiting or triggering a refresh. */
    peek() {
      return snapshot;
    },

    status() {
      return {
        ready: Boolean(snapshot),
        count: snapshot?.records.length ?? 0,
        etag: snapshot?.etag ?? null,
        fetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
        ageSeconds: ageSeconds(),
        stale: isStale(),
        refreshing: Boolean(refreshing),
        consecutiveFailures: failures,
        lastError,
      };
    },
  };
}
