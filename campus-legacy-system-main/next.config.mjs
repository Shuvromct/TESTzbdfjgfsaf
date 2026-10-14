/** @type {import('next').NextConfig} */

/* The client is one static file. The script tag carries the deployment's commit
   id, so the URL changes whenever the code does — which means the file can be
   cached for good and a returning browser never asks for it again. */
const BUILD = process.env.VERCEL_GIT_COMMIT_SHA || 'dev';

export default {
  serverExternalPackages: ['pg', 'bcryptjs'],
  env: { NEXT_PUBLIC_BUILD_ID: BUILD },

  /* The SQL backup carries the schema, and it reads it from the file that
     built the database rather than keeping a second copy of it in the code —
     two descriptions of one schema drift apart, and the one in the backup is
     the one nobody notices is wrong until the day it is needed. Next traces
     imports, not files opened by name, so this says to carry it along. */
  outputFileTracingIncludes: {
    '/api/state/backup': ['./schema.sql', './migrations/*.sql'],
    '/api/cron/backup': ['./schema.sql', './migrations/*.sql'],
  },

  /* Every section has its own address — /tasks, /tasks/CL25-07, /budget — and
     the client decides what to draw. The server has no page at those paths, so
     a refresh or a pasted link would be a 404; `fallback` runs only after
     everything real has been tried, so the API routes, /app.js and /app.css
     are served normally and anything left over gets the app shell.

     /api is excluded by hand: a mistyped endpoint must stay a 404, or the
     client would parse the HTML of this page as if it were JSON. */
  async rewrites() {
    return {
      /* The home page is the static shell, not a React page. */
      beforeFiles: [{ source: '/', destination: '/shell.html' }],
      fallback: [{ source: '/:path((?!api/).*)', destination: '/shell.html' }],
    };
  },
  async headers() {
    return [
      {
        /* Checked on every load rather than cached for a year. The shell is a
           plain file and cannot carry a version in the URL, so the browser
           asks instead — a couple of hundred bytes, almost always a 304. */
        source: '/:file(app\\.js|app\\.css|shell\\.html)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
      {
        /* a project record is not for framing or indexing */
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};
