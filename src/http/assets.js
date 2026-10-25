import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Versioned URLs for everything in /public, without a build step.
 *
 * Files are served under /static/<version>/…, where the version is a hash of
 * all their contents. Because ES module imports and CSS url()s are relative,
 * they inherit the version automatically, so every asset can be cached
 * forever and a deploy that changes anything changes every URL.
 */
export async function createAssets({ publicDir, versioned }) {
  const files = await listFiles(publicDir);
  const toPath = (file) => relative(publicDir, file).split(sep).join('/');

  let version = 'dev';
  if (versioned) {
    const hash = createHash('sha256');
    for (const file of files) hash.update(toPath(file)).update(await readFile(file));
    version = hash.digest('hex').slice(0, 10);
  }

  const url = (path) => `/static/${version}/${path.replace(/^\//, '')}`;
  return {
    version,
    url,
    /** Every browser module, for <link rel="modulepreload"> so imports don't load in a waterfall. */
    modules: files.map(toPath).filter((path) => path.startsWith('js/') && path.endsWith('.js')).map(url),
  };
}
