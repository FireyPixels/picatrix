# Drawasaurus Image Draw

Auto-draw any image on [Drawasaurus](https://www.drawasaurus.org) using the game's WebSocket protocol. Includes three tools:

1. **draw_image.js** -- A Node.js CLI script that joins a room and draws a provided image when it is your turn.
2. **davinci.js** -- An advanced version using a highly optimized region-based algorithm and automatic Google Image Search.
3. **picasso.js** -- An alternative sophisticated drawing bot that evaluates images using entropy/darkness scoring and simplifies paths using the Ramer-Douglas-Peucker algorithm.
4. **drawasaurus_dropdraw.user.js** -- A Tampermonkey/Greasemonkey userscript that lets you drag and drop images directly onto the Drawasaurus page to draw them in-game using the Davinci algorithm.

---

## How It Works

All tools convert an image into a series of `drawLine` WebSocket messages that the Drawasaurus server accepts. The image is resized to fit the 880x750 canvas, scanned row by row, and broken into horizontal line segments grouped by colour. Each segment becomes a single draw command sent over the WebSocket connection.

`davinci.js` and the DropDraw userscript improve on this with a heavily optimized algorithm that slashes message counts by over 75%:
- **Connected Component Flood-fill** identifies all connected regions of identical color.
- **Space-Filling Polylines (Meandering)** generate continuous, snaking brush strokes that color entire regions in single, uninterrupted lines.
- **Greedy Nearest-Neighbor Edge Packing** mathematically searches for and links nearby edge boundaries into gigantic continuous outlines instead of fragmented line segments.

---

## Prerequisites

- Node.js 18 or later
- npm

## Setup

```bash
git clone https://github.com/FireyPixels/picatrix.git
cd picatrix
npm install
```

Edit the top of `draw_image.js`, `davinci.js`, or `picasso.js` to set your `ROOM_NAME` and `USERNAME`.

---

## Node.js CLI -- Basic (`draw_image.js`)

Single-pass drawer. Provide an image path on the command line.

```bash
node draw_image.js path/to/image.png
```

| Variable | Default | Description |
|---|---|---|
| `ROOM_NAME` | `'The Cool Room'` | Room to join |
| `USERNAME` | `'DaVinci'` | Display name |
| `LINE_THICK` | `5` | Brush thickness (3-16) |
| `COLOUR_THRESHOLD` | `30` | RGB distance to merge similar colours |

---

## Node.js CLI -- Smart (`davinci.js`)

Two-pass region-filling drawer with optional automatic image search.

### Manual mode (provide image)

```bash
node davinci.js path/to/image.png
```

### Auto mode (no image argument)

```bash
node davinci.js
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
| `ROOM_NAME` | `'The Cool Room2'` | Room to join |
| `USERNAME` | `'DaVinci'` | Display name |
| `NUM_COLORS`| `16` | Number of colors to quantize the image into |
| `FILL_THICK`| `9` | Fill pass brush thickness |
| `MIN_REGION_PIXELS` | `20` | Ignore regions smaller than this |
| `EDGE_THICK` | `4` | Edge pass brush thickness |
| `EDGE_YSTEP` | `4` | Interval for scanning horizontal edge rows |
| `EDGE_RADIUS`| `3` | Distance from color boundary to trace edges |

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

- Completely executes the massive message-saving Davinci drawing algorithm purely in the browser.
- Drag and drop image files from your computer.
- Drag images directly from other browser tabs or Google Images.
- Local canvas rendering so the drawer can see the result in real time.
- Status badge with progress counter.

---

## Node.js CLI -- Picasso (`picasso.js`)

An alternative bot that prioritizes drawing sketch-like images (line art, manga, clip art).

```bash
node picasso.js
```

**Features:**
- Uses a path-finding BFS search to identify and ignore backgrounds.
- Scores candidates from Google Image Search based on pixel entropy, darkness, and aspect ratio.
- Employs the Ramer-Douglas-Peucker (RDP) algorithm to selectively simplify vectors and fit curves precisely with few points.

---

## Dependencies

| Package | Purpose |
|---|---|
| [ws](https://www.npmjs.com/package/ws) | WebSocket client for Node.js |
| [sharp](https://www.npmjs.com/package/sharp) | Image loading and quantization |
| [g-i-s](https://www.npmjs.com/package/g-i-s) | Google Image Search (used by `davinci.js`) |
| [google-img-scrap](https://www.npmjs.com/package/google-img-scrap) | Alternative Google Image search (used by `picasso.js`) |
| [axios](https://www.npmjs.com/package/axios) | HTTP requests (used by `picasso.js`) |

The Tampermonkey userscript has no external dependencies. It uses the browser's built-in Canvas API for image processing and hooks into the game's existing WebSocket connection.

---

## License

MIT
