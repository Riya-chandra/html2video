#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { render, closeBrowser } = require('./renderer');

const usage = `
Render an HTML file or URL to video.

  node src/cli.js --in examples/pulse.html --out out.mp4 --duration 6 --fps 30
  node src/cli.js --url https://example.com --out out.mp4 --mode realtime

Options
  --in <file>        HTML file to render
  --url <url>        Page to render instead of a file
  --out <file>       Output path (.mp4, .webm, .gif)   default out.mp4
  --width  <px>      default 1280
  --height <px>      default 720
  --fps <n>          default 30
  --duration <sec>   default 5
  --scale <n>        device pixel ratio, 2 = retina    default 1
  --crf <n>          14 sharp .. 40 small              default 20
  --mode <m>         deterministic | realtime          default deterministic
  --wait-for <sel>   wait for a selector before capture
  --wait <ms>        extra delay before capture
  --transparent      alpha channel (webm only)
`;

function parse(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

(async () => {
  const args = parse(process.argv);
  if (args.help || (!args.in && !args.url)) {
    console.log(usage);
    process.exit(args.help ? 0 : 1);
  }

  const outPath = path.resolve(args.out || 'out.mp4');
  const format = path.extname(outPath).slice(1) || 'mp4';
  const startedAt = Date.now();
  let lastLogged = -1;

  try {
    const result = await render({
      html: args.in ? fs.readFileSync(path.resolve(args.in), 'utf8') : undefined,
      url: args.url,
      outPath,
      format,
      width: Number(args.width) || 1280,
      height: Number(args.height) || 720,
      fps: Number(args.fps) || 30,
      duration: Number(args.duration) || 5,
      scale: Number(args.scale) || 1,
      crf: Number(args.crf) || 20,
      mode: args.mode === 'realtime' ? 'realtime' : 'deterministic',
      transparent: Boolean(args.transparent),
      waitForSelector: args['wait-for'],
      waitBeforeCapture: Number(args.wait) || 0,
      onProgress: ({ percent }) => {
        if (percent !== lastLogged && percent % 5 === 0) {
          lastLogged = percent;
          process.stdout.write(`\rrendering ${percent}%`);
        }
      },
    });
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const mb = (fs.statSync(outPath).size / 1e6).toFixed(2);
    console.log(`\n${outPath} — ${result.frames} frames, ${mb} MB, ${secs}s`);
  } catch (err) {
    console.error('\nRender failed:', err.message);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
})();
