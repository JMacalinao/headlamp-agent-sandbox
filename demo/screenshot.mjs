// Usage: node demo/screenshot.mjs <url> <out.png> [width] [height] [ready-expression]
// Drives Chromium over the DevTools protocol so the page viewport is exactly the image size;
// `chromium --screenshot` sizes the image from the outer window and leaves a band at the bottom.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, width = '1440', height = '810', ready = 'window.demoReady === true'] =
  process.argv.slice(2);
const profile = mkdtempSync(join(tmpdir(), 'shot-'));
const browser = spawn('chromium', [
  '--headless',
  '--no-sandbox',
  '--hide-scrollbars',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  'about:blank',
]);

const endpoint = await new Promise((resolve, reject) => {
  browser.stderr.on('data', chunk => {
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(String(chunk));
    if (match) resolve(new URL(match[1]).host);
  });
  browser.on('exit', code => reject(new Error(`chromium exited with ${code}`)));
});

const page = await (
  await fetch(`http://${endpoint}/json/new?about:blank`, { method: 'PUT' })
).json();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));

let nextId = 0;
const send = (method, params = {}) =>
  new Promise(resolve => {
    const id = ++nextId;
    const onMessage = event => {
      const message = JSON.parse(event.data);
      if (message.id === id) {
        socket.removeEventListener('message', onMessage);
        resolve(message.result);
      }
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });

await send('Emulation.setDeviceMetricsOverride', {
  width: Number(width),
  height: Number(height),
  deviceScaleFactor: 2,
  mobile: false,
});
await send('Page.navigate', { url });
const deadline = Date.now() + 60_000;
while (!(await send('Runtime.evaluate', { expression: ready })).result.value) {
  if (Date.now() > deadline) throw new Error(`timed out waiting for: ${ready}`);
  await new Promise(wake => setTimeout(wake, 250));
}
// Let the last resize, font swap and repaint land.
await new Promise(wake => setTimeout(wake, 1000));
const { data } = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(data, 'base64'));
socket.close();
browser.kill();
