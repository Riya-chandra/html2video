const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const ffmpegPath = require('ffmpeg-static');
const { installVirtualClock } = require('./virtual-clock');

let browserPromise = null;

/** One Chromium for the whole process — launching per job is the slow part. */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--mute-audio',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        '--disable-lcd-text',
      ],
    });
    const b = await browserPromise;
    b.on('disconnected', () => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    browserPromise = null;
    await b.close().catch(() => {});
  }
}

const even = (n) => (n % 2 === 0 ? n : n + 1);

function encoderArgs(format, fps, crf, outPath) {
  const base = ['-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0'];
  if (format === 'webm') {
    return [
      ...base, '-c:v', 'libvpx-vp9', '-crf', String(crf + 10), '-b:v', '0',
      '-row-mt', '1', '-pix_fmt', 'yuv420p', '-y', outPath,
    ];
  }
  if (format === 'gif') {
    return [
      ...base,
      '-vf', `fps=${fps},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`,
      '-loop', '0', '-y', outPath,
    ];
  }
  return [
    ...base,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'animation',
    '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-y', outPath,
  ];
}

/**
 * @param {object} opts
 * @param {string} [opts.html]        inline HTML source
 * @param {string} [opts.url]         page to load instead of html
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {number} opts.duration      seconds
 * @param {number} [opts.scale]       device pixel ratio (1 = fast, 2 = retina)
 * @param {'deterministic'|'realtime'} [opts.mode]
 * @param {'mp4'|'webm'|'gif'} [opts.format]
 * @param {number} [opts.crf]         18 (best) .. 32 (small)
 * @param {number} [opts.quality]     jpeg frame quality 1-100
 * @param {boolean} [opts.transparent] capture alpha (png frames, webm only)
 * @param {string} opts.outPath
 * @param {(p:{frame:number,total:number,percent:number})=>void} [opts.onProgress]
 */
async function render(opts) {
  const {
    html, url,
    width = 1280, height = 720, fps = 30, duration = 5,
    scale = 1, mode = 'deterministic', format = 'mp4',
    crf = 20, quality = 92, transparent = false,
    waitForSelector, waitBeforeCapture = 0,
    outPath, onProgress,
  } = opts;

  if (!html && !url) throw new Error('Provide either html or url');
  const W = even(Math.round(width));
  const H = even(Math.round(height));
  const totalFrames = Math.max(1, Math.round(fps * duration));

  const browser = await getBrowser();
  const page = await browser.newPage();
  const shotType = transparent || format === 'gif' ? 'png' : 'jpeg';

  let ffmpeg;
  try {
    await page.setViewport({ width: W, height: H, deviceScaleFactor: scale });
    await page.setCacheEnabled(true);

    if (mode === 'deterministic') {
      await page.evaluateOnNewDocument(installVirtualClock, Date.now());
    }

    if (url) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    } else {
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    }

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 30000 });
    }
    // Let webfonts settle so frame 1 isn't a fallback face.
    await page.evaluate(() => document.fonts && document.fonts.ready);
    if (waitBeforeCapture > 0) {
      await new Promise((r) => setTimeout(r, waitBeforeCapture));
    }

    ffmpeg = spawn(ffmpegPath, encoderArgs(format, fps, crf, outPath), {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let ffErr = '';
    ffmpeg.stderr.on('data', (d) => {
      ffErr += d.toString();
      if (ffErr.length > 8000) ffErr = ffErr.slice(-8000);
    });
    const done = new Promise((resolve, reject) => {
      ffmpeg.on('error', reject);
      ffmpeg.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${ffErr}`)));
    });

    const write = (buf) =>
      new Promise((resolve, reject) => {
        if (ffmpeg.stdin.write(buf)) return resolve();
        ffmpeg.stdin.once('drain', resolve);
        ffmpeg.stdin.once('error', reject);
      });

    const shot = () =>
      page.screenshot({
        type: shotType,
        ...(shotType === 'jpeg' ? { quality } : {}),
        omitBackground: transparent,
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      });

    if (mode === 'deterministic') {
      const step = 1000 / fps;
      for (let i = 0; i < totalFrames; i++) {
        await page.evaluate((t) => window.__seek && window.__seek(t), i * step);
        await write(await shot());
        if (onProgress) {
          onProgress({ frame: i + 1, total: totalFrames, percent: Math.round(((i + 1) / totalFrames) * 100) });
        }
      }
    } else {
      // Wall-clock capture: grab as fast as Chromium allows, then resample to fps.
      const startedAt = Date.now();
      const endAt = startedAt + duration * 1000;
      let written = 0;
      let last = await shot();
      while (written < totalFrames) {
        const targetElapsed = (written * 1000) / fps;
        const now = Date.now() - startedAt;
        if (now < targetElapsed && Date.now() < endAt) {
          await new Promise((r) => setTimeout(r, Math.min(targetElapsed - now, 16)));
          last = await shot();
          continue;
        }
        await write(last);
        written++;
        if (onProgress) {
          onProgress({ frame: written, total: totalFrames, percent: Math.round((written / totalFrames) * 100) });
        }
      }
    }

    ffmpeg.stdin.end();
    await done;
    return { outPath, frames: totalFrames, width: W, height: H, fps, format };
  } catch (err) {
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGKILL');
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

function tmpOut(ext) {
  const dir = path.join(os.tmpdir(), 'html2video');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

module.exports = { render, getBrowser, closeBrowser, tmpOut };
