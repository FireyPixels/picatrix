# Drawasaurus Image Draw

Auto-draw any image on [Drawasaurus](https://www.drawasaurus.org) using the game's WebSocket protocol. Includes two tools:

1. **draw_image.js** -- A Node.js CLI script that joins a room and draws an image when it is your turn.
2. **drawasaurus_dropdraw.user.js** -- A Tampermonkey/Greasemonkey userscript that lets you drag and drop images directly onto the Drawasaurus page to draw them in-game.

---

## How It Works

Both tools convert an image into a series of `drawLine` WebSocket messages that the Drawasaurus server accepts. The image is resized to fit the 880x750 canvas, scanned row by row, and broken into horizontal line segments grouped by colour. Each segment becomes a single draw command sent over the WebSocket connection.

---

## Node.js CLI (`draw_image.js`)

### Prerequisites

- Node.js 18 or later
- npm

### Setup

```bash
git clone <repo-url>
cd drawasaurus-image-draw
npm install
```

### Configuration

Edit the top of `draw_image.js` to set:

| Variable | Default | Description |
|---|---|---|
| `ROOM_NAME` | `'The Cool Room'` | The Drawasaurus room to join |
| `USERNAME` | `'Mask off'` | Display name in the room |
| `LINE_THICK` | `5` | Brush thickness (3 = detailed/slow, 16 = fast/blocky) |
| `COLOUR_THRESHOLD` | `30` | RGB distance to merge similar colours (lower = more accurate, more messages) |
| `SKIP_WHITE` | `true` | Skip white pixels (canvas background is white) |

### Usage

```bash
node draw_image.js path/to/image.png
```

The script will:

1. Load and resize the image to fit the canvas.
2. Convert it into draw commands.
3. Connect to the specified room via WebSocket.
4. Wait for your drawing turn.
5. Automatically pick the first word and draw the image.

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

## Drawing Settings

Both tools share the same core settings. The defaults produce a good balance between speed and quality:

| Setting | Value | Effect |
|---|---|---|
| `LINE_THICK` | `5` | Brush size in pixels. Lower = more detail, more messages. Range: 3-16. |
| `COLOUR_THRESHOLD` | `30` | How different two colours must be before starting a new segment. Lower = more accurate. |
| `SKIP_WHITE` | `true` | Skips white pixels since the canvas background is already white. |
| `WHITE_THRESHOLD` | `240` | Pixels with R, G, and B all above this value are treated as white. |
| `CANVAS_W` / `CANVAS_H` | `880` / `750` | Drawasaurus canvas dimensions (do not change). |

---

## Dependencies

| Package | Purpose |
|---|---|
| [ws](https://www.npmjs.com/package/ws) | WebSocket client for Node.js (used by `draw_image.js` only) |
| [sharp](https://www.npmjs.com/package/sharp) | Image loading and resizing (used by `draw_image.js` only) |

The Tampermonkey userscript has no external dependencies. It uses the browser's built-in Canvas API for image processing and hooks into the game's existing WebSocket connection.

---

## License

MIT
