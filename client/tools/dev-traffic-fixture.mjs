/** Loopback browser verification only; excluded from production builds. */
export function devTrafficFixture() {
  return { name: 'dev-traffic-fixture', apply: 'serve', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path.endsWith('/__dev/traffic/download') && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
          'Content-Length': String(48 * 65536) });
        let chunks = 0;
        const timer = setInterval(() => {
          response.write(Buffer.alloc(65536, 42));
          if (++chunks === 48) { clearInterval(timer); response.end(); }
        }, 250);
        response.on('close', () => clearInterval(timer));
      } else if (path.endsWith('/__dev/traffic/upload') && request.method === 'POST') {
        let bytes = 0, timer;
        request.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) request.destroy();
        });
        request.on('end', () => {
          timer = setTimeout(() => {
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ received: bytes }));
          }, 6000);
        });
        response.on('close', () => clearTimeout(timer));
      } else next();
    });
  } };
}
