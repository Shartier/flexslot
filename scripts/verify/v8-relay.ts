// V8: start the path-limited relay on 127.0.0.1:8790 in front of FlexSlot on 127.0.0.1:8787.
// Point the tunnel at the relay, never at FlexSlot itself:  cloudflared tunnel --url http://127.0.0.1:8790
// Usage: node scripts/verify/v8-relay.ts   (stop with Ctrl+C)

import { createRelay } from './relay.ts';

const port = Number(process.env.FLEXSLOT_RELAY_PORT ?? 8790);
const upstream = `http://127.0.0.1:${Number(process.env.FLEXSLOT_PORT ?? 8787)}`;
const server = createRelay({ upstream, log: (l) => console.log(JSON.stringify({ t: new Date().toISOString(), ...l })) });
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ t: new Date().toISOString(), event: 'relay.listening', listen: `127.0.0.1:${port}`, passes: 'POST /webhooks/paypal only' })));
const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
