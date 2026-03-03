# Drawasaurus Image Draw

Auto-draw any image on [Drawasaurus](https://www.drawasaurus.org) using the game's WebSocket protocol. Includes three tools:

1. **draw_image.js** -- A Node.js CLI script that joins a room and draws a provided image when it is your turn.
2. **draw_smart.js** -- An enhanced version with edge-aware two-pass drawing and automatic Google Image Search.
3. **drawasaurus_dropdraw.user.js** -- A Tampermonkey/Greasemonkey userscript that lets you drag and drop images directly onto the Drawasaurus page to draw them in-game.

---

## How It Works

All tools convert an image into a series of `drawLine` WebSocket messages that the Drawasaurus server accepts. The image is resized to fit the 880x750 canvas, scanned row by row, and broken into horizontal line segments grouped by colour. Each segment becomes a single draw command sent over the WebSocket connection.

`draw_smart.js` improves on this with a two-pass approach:
- **Sobel edge detection** identifies colour boundaries in the image.
- **Fill pass** draws flat colour regions with a thick brush and loose colour threshold.
- **Edge pass** redraws boundaries with a thin brush and tight colour threshold for crisp outlines.

---

## Prerequisites

- Node.js 18 or later
- npm

## Setup

```bash
git clone <repo-url>
cd drawasaurus-image-draw
npm install
```

Edit the top of `draw_image.js` or `draw_smart.js` to set your `ROOM_NAME` and `USERNAME`.

---

## Node.js CLI -- Basic (`draw_image.js`)

Single-pass drawer. Provide an image path on the command line.

```bash
node draw_image.js path/to/image.png
```

| Variable | Default | Description |
|---|---|---|
| `ROOM_NAME` | `'The Cool Room'` | Room to join |
| `USERNAME` | `'Mask off'` | Display name |
| `LINE_THICK` | `5` | Brush thickness (3-16) |
| `COLOUR_THRESHOLD` | `30` | RGB distance to merge similar colours |

---

## Node.js CLI -- Smart (`draw_smart.js`)

Two-pass edge-aware drawer with optional automatic image search.

### Manual mode (provide image)

```bash
node draw_smart.js path/to/image.png
```

### Auto mode (no image argument)

```bash
node draw_smart.js
```

In auto mode, the script will:

1. Connect to the room and wait for your drawing turn.
2. When the word picker appears, pick the first word.
3. Search Google Images for a simple drawing/clipart of that word.
4. Download, process, and draw the image automatically.

This repeats every round with whatever word is given.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `ROOM_NAME` | `'The Cool Room'` | Room to join |
| `USERNAME` | `'Mask off'` | Display name |
| `FILL_THICK` | `7` | Fill pass brush thickness |
| `FILL_THRESHOLD` | `40` | Fill pass colour merge distance |
| `EDGE_THICK` | `3` | Edge pass brush thickness |
| `EDGE_THRESHOLD` | `12` | Edge pass colour merge distance |
| `SOBEL_THRESHOLD` | `50` | Edge detection sensitivity (lower = more edges) |

---

## Tampermonkey Userscript (`drawasaurus_dropdraw.user.js`)

### Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Firefox).
2. Open Tampermonkey and create a new script.
3. Paste the entire contents of `drawasaurus_dropdraw.user.js` into the editor.
4. Save the script.

### Usage

1. Open [Drawasaurus](https://www.drawasaurus.org) and join a room.
2. When it is your turn to draw, drag and drop an image file onto the page (or drag an image directly from another browser tab / Google Images).
3. The script will process the image and send all the draw commands automatically.
4. A status badge in the bottom-right corner shows progress.

### Features

- Drag and drop image files from your computer.
- Drag images directly from other browser tabs or Google Images.
- Local canvas rendering so the drawer can see the result in real time.
- Status badge with progress counter.

---

## Dependencies

| Package | Purpose |
|---|---|
| [ws](https://www.npmjs.com/package/ws) | WebSocket client for Node.js |
| [sharp](https://www.npmjs.com/package/sharp) | Image loading and resizing |
| [g-i-s](https://www.npmjs.com/package/g-i-s) | Google Image Search (used by `draw_smart.js` auto mode) |

The Tampermonkey userscript has no external dependencies. It uses the browser's built-in Canvas API for image processing and hooks into the game's existing WebSocket connection.

---

## License

MIT
