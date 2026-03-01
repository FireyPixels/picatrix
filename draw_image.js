const WebSocket = require('ws');
const sharp = require('sharp');
const path = require('path');

// ============================================
//   CONFIGURATION
// ============================================
const ROOM_NAME = 'The Cool Room';
const USERNAME = 'Mask off';
const DRAWASAURUS_VERSION = '52a35d2755939386a8de91b399fc0ff770deb697';

// Image path - change this to your image
const IMAGE_PATH = process.argv[2] || './input.png';

// Drawing settings
const LINE_THICK = 5;         // 3=detailed/slow, 16=fast/blocky (allowed: 3-16)
const CANVAS_W = 880;
const CANVAS_H = 750;
const COLOUR_THRESHOLD = 30;  // RGB distance to merge similar colours (lower=more accurate, more messages)
const SKIP_WHITE = true;      // Skip white-ish pixels (canvas bg is white)
const WHITE_THRESHOLD = 240;  // Pixels with R,G,B all above this are "white"

// ============================================
//   IMAGE PROCESSING
// ============================================
async function loadImage(imagePath) {
    const absPath = path.resolve(imagePath);
    console.log(`[Image] Loading: ${absPath}`);

    const { data, info } = await sharp(absPath)
        .resize(CANVAS_W, CANVAS_H, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

    console.log(`[Image] Loaded: ${info.width}x${info.height} (${info.channels} channels)`);
    return { pixels: data, width: info.width, height: info.height, channels: info.channels };
}

function getPixel(pixels, width, channels, x, y) {
    const idx = (y * width + x) * channels;
    return {
        r: pixels[idx],
        g: pixels[idx + 1],
        b: pixels[idx + 2],
        a: channels === 4 ? pixels[idx + 3] : 255
    };
}

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function colourDistance(c1, c2) {
    return Math.sqrt((c1.r - c2.r) ** 2 + (c1.g - c2.g) ** 2 + (c1.b - c2.b) ** 2);
}

function isWhite(c) {
    return c.r >= WHITE_THRESHOLD && c.g >= WHITE_THRESHOLD && c.b >= WHITE_THRESHOLD;
}

// ============================================
//   CONVERT IMAGE TO drawLine MESSAGES
// ============================================
async function imageToDrawMessages(imagePath) {
    const img = await loadImage(imagePath);
    const messages = [];
    const TIMING_VALUES = [22, 28, 35, 43];

    // Scan row by row, stepping by thickness
    for (let y = 0; y < img.height; y += LINE_THICK) {
        let segStart = null;
        let segColour = null;
        let segPoints = [];

        for (let x = 0; x < img.width; x += 2) {  // sample every 2px for speed
            const pixel = getPixel(img.pixels, img.width, img.channels, x, y);

            // Skip transparent or white pixels
            if (pixel.a < 128 || (SKIP_WHITE && isWhite(pixel))) {
                // Flush current segment
                if (segPoints.length >= 2) {
                    messages.push(buildDrawMsg(segPoints, segColour, TIMING_VALUES));
                }
                segStart = null;
                segColour = null;
                segPoints = [];
                continue;
            }

            if (segColour === null) {
                // Start new segment
                segColour = pixel;
                segStart = x;
                segPoints = [[x, y]];
            } else if (colourDistance(pixel, segColour) <= COLOUR_THRESHOLD) {
                // Continue segment (similar colour)
                segPoints.push([x, y]);
            } else {
                // Colour changed - flush segment and start new one
                if (segPoints.length >= 2) {
                    messages.push(buildDrawMsg(segPoints, segColour, TIMING_VALUES));
                }
                segColour = pixel;
                segStart = x;
                segPoints = [[x, y]];
            }
        }

        // Flush last segment of this row
        if (segPoints.length >= 2) {
            messages.push(buildDrawMsg(segPoints, segColour, TIMING_VALUES));
        }
    }

    console.log(`[Image] Generated ${messages.length} drawLine messages`);
    return messages;
}

function buildDrawMsg(points, colour, timingValues) {
    // Build lines array with timing markers every 3 points
    const lines = [];
    for (let i = 0; i < points.length; i++) {
        lines.push(points[i]);
        if ((i + 1) % 3 === 0 && i < points.length - 1) {
            lines.push([timingValues[Math.floor(Math.random() * timingValues.length)]]);
        }
    }

    return {
        a: ["drawLine", {
            lines,
            colour: rgbToHex(colour.r, colour.g, colour.b),
            thick: LINE_THICK
        }]
    };
}

// ============================================
//   SEND ALL DRAW MESSAGES
// ============================================
async function sendDraw(ws, messages) {
    console.log(`[Draw] Sending ${messages.length} drawLine messages...`);

    for (let i = 0; i < messages.length; i++) {
        if (ws.readyState !== WebSocket.OPEN) {
            console.log(`[Draw] Disconnected at ${i}/${messages.length}`);
            return;
        }
        ws.send(JSON.stringify(messages[i]));

        // Small yield every 5 messages for stability
        if ((i + 1) % 5 === 0) await new Promise(r => setTimeout(r, 2));
        if ((i + 1) % 100 === 0) console.log(`[Draw] Progress: ${i + 1}/${messages.length}`);
    }

    console.log(`[Draw] ALL ${messages.length} messages sent!`);
}

// ============================================
//   MAIN
// ============================================
async function start() {
    // Pre-process image before connecting
    console.log(`
========================================
  Drawasaurus Image Drawer
========================================
Room     : "${ROOM_NAME}"
Image    : "${IMAGE_PATH}"
Thick    : ${LINE_THICK}
Canvas   : ${CANVAS_W}x${CANVAS_H}
Threshold: ${COLOUR_THRESHOLD}
========================================
`);

    const drawMessages = await imageToDrawMessages(IMAGE_PATH);

    // Now connect and wait for turn
    const wsUrl = `wss://server.drawasaurus.org/room/${encodeURIComponent(ROOM_NAME)}?version=${DRAWASAURUS_VERSION}`;
    console.log(`[+] Connecting to "${ROOM_NAME}"...`);

    const ws = new WebSocket(wsUrl, {
        headers: {
            'Origin': 'https://www.drawasaurus.org',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    let drawSent = false;

    ws.on('open', () => {
        console.log('[+] Connected');
        ws.send(JSON.stringify({ a: ["submitUsername", USERNAME] }));
    });

    ws.on('message', (data) => {
        try {
            const str = String(data);
            if (!str.startsWith('{')) return;
            const parsed = JSON.parse(str);
            if (!parsed.a) return;
            const [event, ...args] = parsed.a;

            if (event === 'setUsername') {
                console.log('[+] Joining room...');
                ws.send(JSON.stringify({ a: ["joinRoom", ROOM_NAME, ""] }));
            }

            if (event === 'joinedRoom') {
                console.log(`[+] In room! ${drawMessages.length} draw commands ready. Waiting for turn...`);
            }

            if (event === 'prepareDrawing') {
                console.log(`[Game] Drawer: "${args[0]}"`);
            }

            if (event === 'showWordPicker') {
                try {
                    const words = JSON.parse(args[0]);
                    console.log(`[Game] Picking: "${words[0][0]}"`);
                    ws.send(JSON.stringify({ a: ["chooseWord", 0] }));
                } catch (e) { }
            }

            // Our turn - DRAW THE IMAGE
            if (event === 'youDrawing') {
                console.log(`[Game] youDrawing: "${args[0]}"`);
                if (!drawSent) {
                    drawSent = true;
                    console.log(`[Draw] >>> DRAWING IMAGE (${drawMessages.length} commands) <<<`);
                    sendDraw(ws, drawMessages);
                }
            }

            if (event === 'startDrawing') {
                const drawerName = args[0];
                if (!drawSent && (drawerName === USERNAME || drawerName.startsWith(USERNAME))) {
                    drawSent = true;
                    console.log(`[Draw] >>> DRAWING IMAGE (backup) <<<`);
                    sendDraw(ws, drawMessages);
                }
            }

            if (event === 'endRound') {
                console.log('[Game] Round ended');
                drawSent = false;
            }

            const silent = ['timerUpdate', 'ping', 'drawLine', 'drawCanvas', 'drawFill',
                'updateUsers', 'setUsername', 'joinedRoom', 'prepareDrawing',
                'showWordPicker', 'startDrawing', 'endRound', 'youDrawing'];
            if (!silent.includes(event)) {
                console.log(`[Event] ${event}: ${JSON.stringify(args).substring(0, 120)}`);
            }

        } catch (err) { }
    });

    ws.on('error', (err) => console.error(`[!] Error: ${err.message}`));
    ws.on('close', () => console.log('[!] Disconnected.'));

    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ a: ["ping"] }));
    }, 20000);

    process.on('SIGINT', () => { ws.close(); process.exit(0); });
}

start().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
