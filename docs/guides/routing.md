---
layout: ../../layouts/content.astro
title: Routing
published: true
description: This guide will walk you through some common routing scenarios and how to configure the routes option to support them in development.
---

As a web build tool, Snowpack has no knowledge of how (or where) your application is served in production. But Snowpack's dev server can be customized to recreate something close to your production environment for local development.

This guide will walk you through some common routing scenarios and how to configure the `routes` option to support them in development.

### Scenario 1: SPA Fallback Paths

Single Page Applications (SPA) give the client application complete control over routing logic. The web host itself has no idea what is a valid route and what is a 404, since that logic lives completely in the client. Therefore, every route (valid or not) must be served the same HTML response that will load and run the HTML/JS/CSS application in the browser. This special file is called the "SPA Fallback".

To implement this pattern, you'll want to define a single "catch-all" route for development:

```js
// snowpack.config.mjs
export default {
  routes: [
    {
      match: 'routes',
      src: '.*',
      dest: '/index.html',
    },
  ],
};
```

This tells Snowpack's dev server to serve the fallback `/index.html` URL for all routes (`.*` in RegEx means "match everything").

`"match": "routes"` refers to all URLs that either do not include a file extension or that include the ".html" file extension. If you changed the above example to `"match": "all"` instead, then all URLs (including JS, CSS, Image files and more) would respond with the fallback HTML file.

### Scenario 2: Proxy API Paths

Many modern frontend applications will talk directly to an API. Often this API is hosted as a seperate application at another domain (ex: `api.example.com/users`) and no special server configuration is needed to talk with it. However in some cases, your API may be hosted at the same domain as your website using a different path scheme (ex: `www.example.com/api/users`).

To serve the correct API response to a URL like `/api/users` in development, you can configure Snowpack to proxy some requests to another server. In this example, we'll proxy all "/api/\*" requests to another server that we have running locally on port `3001`:

```js
// snowpack.config.mjs
import proxy from 'http2-proxy';

export default {
  routes: [
    {
      src: '/api/.*',
      dest: (req, res) => {
        // remove /api prefix (optional)
        req.url = req.url.replace(/^\/api/, '');

        return proxy.web(req, res, {
          hostname: 'localhost',
          port: 3001,
        });
      },
    },
  ],
};
```

We recommend the [http2-proxy](https://www.npmjs.com/package/http2-proxy) library for proxying requests to another server, which supports a wide range of options to customize how each request is proxied. But feel free to implement the `dest` proxy function however you like. Your own server logic could even be called directly inside of the `dest` function, however this is not recommended over proxying.

### Scenario 3: Proxy WebSocket Requests

Proxied requests can be upgraded to a WebSocket connection via the "upgrade" event handler. This allows you to proxy WebSocket requests through the Snowpack dev server during development. You can learn more about the upgrade mechanism on [MDN Web Docs.](https://developer.mozilla.org/en-US/docs/Web/HTTP/Protocol_upgrade_mechanism#upgrading_to_a_websocket_connection).

```js
// snowpack.config.mjs
import proxy = from 'http2-proxy';

export default {
  routes: [
    {
      src: '/ws',
      upgrade: (req, socket, head) => {
        const defaultWSHandler = (err, req, socket, head) => {
          if (err) {
            console.error('proxy error', err);
            socket.destroy();
          }
        };

        proxy.ws(
          req,
          socket,
          head,
          {
            hostname: 'localhost',
            port: 3001,
          },
          defaultWSHandler,
        );
      },
    },
  ],
};
```

### Scenario 4: Custom Server Rendering

If you only use Snowpack to build assets and rely on your own custom server (ex: Rails, Laravel, etc) for serving HTML, then you probably have no use for routing. Consider reading our guide on [Server-Side Rendering (SSR)](/guides/server-side-render) which explains how to integrate Snowpack into your own server as middleware.

### Scenario 5: Customize Response Headers

Sometimes you need to tweak the response headers with which Snowpack dev server serves assets. `transformHeaders` is provided for these use-cases; it enables you to peek at the response headers just before Snowpack dev server writes the response, and override those response headers if desired.

#### Apply a security policy

If you wish to use [SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer), then you may want to serve your HTML assets with a custom security policy:

```js
// snowpack.config.mjs
export default {
  routes: [
    {
      match: 'routes',
      src: '.*',
      /**
       * @param {import('snowpack').HttpRequestData} _req
       * @param {import('snowpack').DevServerResponseHeaders} proposed
       * @returns {import('snowpack').DevServerResponseHeaders}
       */
      transformHeaders: (_req, proposed) => {
        /** @type {import('snowpack').DevServerResponseHeaders} */
        const extraHeaders = {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp'
        }
        return {
          ...proposed,
          // note: for headers defined as comma-separated lists
          // (such as Cache-control), you'll have to decide whether you want to
          // overwrite (like we do here) or concatenate.
          // https://stackoverflow.com/a/4371395/5257399
          ...extraHeaders
        }
      }
    },
  ],
};
```

The `match: 'routes'` above ensures that this applies only to URLs which lack a file extension, or to `.html` assets. Remove `match: 'routes'` or set it to its default of `match: 'all'` if you wish to modify response headers on **all** assets (e.g. css, js).

#### Modify Content-Type

You may wish to customize response headers based on the details of the request used to retrieve that asset.

If all you're interested in is the file extension, then a simple technique is to use the RegEx capabilities of `src` matching:

```js
// snowpack.config.mjs
export default {
  routes: [
    {
      // snowpack will automatically surround your regex with ^ and $
      // if you haven't done so yourself
      src: '.*\\.wasm',
      /**
       * @param {import('snowpack').HttpRequestData} _req
       * @param {import('snowpack').DevServerResponseHeaders} proposed
       * @returns {import('snowpack').DevServerResponseHeaders}
       */
      transformHeaders: (_req, proposed) => ({
        ...proposed,
        'Content-Type': 'application/wasm'
      })
    },
  ],
};
```

However, if you wish to employ more complex conditions, then you can interrogate the `req` parameter.

The `isHttp2RequestData` helper is provided to help you access the additional properties that HTTP/2 requests expose (namely `authority` and `scheme`). It narrows the type of `HttpRequestData` to either `Http2RequestData` or `Http1RequestData`. You can skip using this helper if you're not interested in the difference.

```js
// snowpack.config.mjs
import { isHttp2RequestData } from 'snowpack'

export default {
  routes: [
    {
      src: '.*',
      /**
       * @param {import('snowpack').HttpRequestData} req
       * @param {import('snowpack').DevServerResponseHeaders} proposed
       * @returns {import('snowpack').DevServerResponseHeaders}
       */
      transformHeaders: (req, proposed) => {
        if (isHttp2RequestData(req)) {
          /**
           * inside here, type is narrowed to:
           * {@link import('snowpack').Http2RequestData}
           */
          if (req.url.endsWith('.wasm')) {
            return {
              ...proposed,
              'Content-Type': 'application/wasm'
            }
          }
          return proposed
        }
        /**
         * from here, type is narrowed to:
         * {@link import('snowpack').Http1RequestData}
         */
        if (req.url?.endsWith('.wasm')) {
          return {
            ...proposed,
            'Content-Type': 'application/wasm'
          }
        }
        return proposed
      }
    },
  ],
};
```