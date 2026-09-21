# html2video

Turn any HTML/CSS/JS page — or a live URL — into an MP4, WebM or GIF.
Web UI, JSON API and a CLI, all backed by one long-lived Chromium and a
streaming ffmpeg pipe.

## Why the output is smooth

Most "HTML to video" tools screen-record the page, so anything heavy comes out
stuttering. This one injects a virtual clock before the page loads: `Date.now`,
`performance.now`, `requestAnimationFrame`, `setTimeout`/`setInterval`, CSS
animations (via `document.getAnimations()`) and `<video>` playback are all
driven by the renderer. Each frame is captured at an exact timestamp, so a
30 fps export has exactly 30 evenly spaced frames per second no matter how slow
the machine is.

Frames go straight into ffmpeg over stdin — nothing is written to disk until
the finished video lands.

## Run it

### Docker (recommended)

```bash
docker compose up --build
# open http://localhost:3000
```

`shm_size: 1gb` in `docker-compose.yml` matters — Chromium crashes on the
default 64 MB `/dev/shm`.

### Without Docker

Needs Node 18+. ffmpeg comes bundled via `ffmpeg-static`; Chromium is
downloaded by Puppeteer on install.

```bash
npm install
npm start
```

To use a Chromium you already have installed:

```bash
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

## CLI

```bash
node src/cli.js --in examples/pulse.html --out out.mp4 --duration 6 --fps 30
node src/cli.js --url https://example.com --out page.mp4 --mode realtime
node src/cli.js --in banner.html --out banner.webm --transparent --scale 2
node src/cli.js --help
```

## API

```bash
curl -X POST http://localhost:3000/api/render \
  -H 'Content-Type: application/json' \
  -d '{"html":"<h1>hi</h1>","width":1280,"height":720,"duration":5,"fps":30}'
# -> { "jobId": "...", "statusUrl": "...", "streamUrl": "..." }
```

| Endpoint | What it does |
| --- | --- |
| `POST /api/render` | Queue a render, returns a job id |
| `GET /api/jobs/:id` | Poll status and progress |
| `GET /api/jobs/:id/events` | Server-sent progress events |
| `GET /api/jobs/:id/file` | Download the finished video |
| `GET /api/health` | Readiness + queue depth |

### Render options

| Field | Default | Notes |
| --- | --- | --- |
| `html` / `url` | — | One of the two is required |
| `width`, `height` | 1280 × 720 | Rounded up to even numbers for H.264 |
| `duration` | 5 | Seconds |
| `fps` | 30 | 1–60 |
| `scale` | 1 | Device pixel ratio; 2 is retina and ~4× slower |
| `format` | `mp4` | `mp4`, `webm`, `gif` |
| `crf` | 20 | 14 sharpest, 40 smallest |
| `mode` | `deterministic` | Use `realtime` for pages driven by network or WebGL timing |
| `transparent` | false | Alpha channel, WebM only |
| `waitForSelector` | — | Hold capture until this element exists |
| `waitBeforeCapture` | 0 | Extra milliseconds before frame 1 |

### Server settings

Environment variables: `PORT`, `MAX_CONCURRENCY` (default 1),
`MAX_DURATION` (60s), `MAX_PIXELS`, `JOB_TTL_MS` (finished renders are deleted
after 30 minutes).

## Deploying

Any host that runs a Docker container with ~1 GB RAM works: Fly.io, Railway,
Render, a plain VPS behind nginx. Two things to keep in mind:

- Put a reverse proxy in front with buffering off for `/api/jobs/:id/events`,
  otherwise progress events arrive all at once.
- Rendering is CPU-bound. Raise `MAX_CONCURRENCY` only as far as you have
  cores; one render happily eats a whole one.

## Limits

- Audio is not muxed. Capture is visual only — add an audio track afterwards
  with ffmpeg if you need one.
- `deterministic` mode can't wait on real network requests mid-render. If a
  page fetches data while animating, use `waitForSelector` or `realtime`.
- Pages that read `Date` at module load before the clock installs are rare but
  possible; `realtime` mode is the fallback.

MIT.
