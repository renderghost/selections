// Entry point. On Vercel this file is the function: it exports the Express app
// and Vercel handles requests. Anywhere else (`npm run dev`, `npm start`) it
// listens on PORT as a normal server.
//
// Vercel only recognises an Express project if this file itself imports and
// creates Express, which is why the app is made here rather than in src/.
import express from 'express';
import { ConfigError } from './src/errors.js';
import { createSite, serve } from './src/site.js';

const app = express();

let site;
try {
  site = await createSite({ app });
} catch (error) {
  // A readable message instead of a stack trace; on Vercel, rethrow so the deploy's logs show it.
  if (!(error instanceof ConfigError) || process.env.VERCEL) throw error;
  console.error(`\n${error.message}\n`);
  process.exit(1);
}

if (!site.config.onVercel) serve(site);

export default app;
