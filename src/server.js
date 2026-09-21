const fs = require('fs');
const path = require('path');
const express = require('express');
const { render, tmpOut, closeBrowser, getBrowser } = require('./renderer');

const PORT = process.env.PORT || 3000;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 1);
const MAX_DURATION = Number(process.env.MAX_DURATION || 60);
const MAX_PIXELS = Number(process.env.MAX_PIXELS || 1920 * 1080);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 30 * 60 * 1000);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/** @type {Map<string, any>} */
const jobs = new Map();
const queue = [];
let running = 0;

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function emit(job, event) {
  job.events.push(event);
  for (const res of job.listeners) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function pump() {
  while (running < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    job.status = 'rendering';
    emit(job, { type: 'status', status: 'rendering' });

    render({
      ...job.options,
      outPath: job.outPath,
      onProgress: (p) => {
        job.percent = p.percent;
        emit(job, { type: 'progress', ...p });
      },
    })
      .then((result) => {
        job.status = 'done';
        job.result = { ...result, size: fs.statSync(job.outPath).size };
        emit(job, { type: 'done', downloadUrl: `/api/jobs/${job.id}/file`, ...job.result });
      })
      .catch((err) => {
        job.status = 'error';
        job.error = err.message;
        emit(job, { type: 'error', message: err.message });
      })
      .finally(() => {
        running--;
        for (const res of job.listeners) res.end();
        job.listeners = [];
        pump();
      });
  }
}

function validate(body) {
  const format = ['mp4', 'webm', 'gif'].includes(body.format) ? body.format : 'mp4';
  const duration = Math.min(Math.max(Number(body.duration) || 5, 0.2), MAX_DURATION);
  const width = Math.min(Math.max(Number(body.width) || 1280, 16), 3840);
  const height = Math.min(Math.max(Number(body.height) || 720, 16), 2160);
  const scale = Math.min(Math.max(Number(body.scale) || 1, 1), 3);
  if (width * height * scale * scale > MAX_PIXELS * 4) {
    throw new Error('Resolution too large for this server. Lower width, height or scale.');
  }
  if (!body.html && !body.url) throw new Error('Nothing to render: send html or url.');
  return {
    html: body.html,
    url: body.url,
    width,
    height,
    duration,
    scale,
    format,
    fps: Math.min(Math.max(Number(body.fps) || 30, 1), 60),
    crf: Math.min(Math.max(Number(body.crf) || 20, 14), 40),
    quality: Math.min(Math.max(Number(body.quality) || 92, 40), 100),
    mode: body.mode === 'realtime' ? 'realtime' : 'deterministic',
    transparent: Boolean(body.transparent) && format === 'webm',
    waitForSelector: body.waitForSelector || undefined,
    waitBeforeCapture: Math.min(Number(body.waitBeforeCapture) || 0, 10000),
  };
}

app.post('/api/render', (req, res) => {
  let options;
  try {
    options = validate(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const job = {
    id: id(),
    status: 'queued',
    percent: 0,
    options,
    outPath: tmpOut(options.format),
    createdAt: Date.now(),
    events: [],
    listeners: [],
  };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  res.status(202).json({ jobId: job.id, statusUrl: `/api/jobs/${job.id}`, streamUrl: `/api/jobs/${job.id}/events` });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    id: job.id,
    status: job.status,
    percent: job.percent,
    error: job.error,
    result: job.result,
    downloadUrl: job.status === 'done' ? `/api/jobs/${job.id}/file` : undefined,
  });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  if (job.status === 'done' || job.status === 'error') return res.end();
  job.listeners.push(res);
  req.on('close', () => {
    job.listeners = job.listeners.filter((l) => l !== res);
  });
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  res.download(job.outPath, `render-${job.id}.${job.options.format}`);
});

app.get('/api/health', async (_req, res) => {
  try {
    await getBrowser();
    res.json({ ok: true, running, queued: queue.length });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// Sweep old renders so /tmp doesn't fill up.
setInterval(() => {
  const now = Date.now();
  for (const [key, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS && job.listeners.length === 0) {
      fs.promises.unlink(job.outPath).catch(() => {});
      jobs.delete(key);
    }
  }
}, 60_000).unref();

const server = app.listen(PORT, () => {
  console.log(`html2video running on http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
