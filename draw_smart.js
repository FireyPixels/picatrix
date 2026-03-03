const WebSocket = require('ws');
const sharp = require('sharp');
const path = require('path');
const https = require('https');
const http = require('http');
const gis = require('g-i-s');

// ============================================
//   CONFIGURATION
// ============================================
const ROOM_NAME = 'The Puppy Room';
const USERNAME = 'Mask off';
const DRAWASAURUS_VERSION = '52a35d2755939386a8de91b399fc0ff770deb697';

const IMAGE_PATH = process.argv[2] || '';
const CANVAS_W = 880;
const CANVAS_H = 750;

// Color quantization (clean, solid color regions -- no noisy transitions)
const NUM_COLORS = 16;

// Pass 1: Fill -- thick brush, covers large areas fast
const FILL_THICK = 9;          // brush size for fill pass
const FILL_OVERLAP = 2;        // rows of overlap between scan lines (prevents visible gaps)
const FILL_XSTEP = 2;          // sample every N pixels horizontally
const FILL_COLOUR_THRESH = 20; // merge threshold within quantized palette (small -- colors are already clean)

// Pass 2: Edge -- thin brush, redraws only near color boundaries for crisp edges
const EDGE_THICK = 3;          // brush size for edge pass
const EDGE_YSTEP = 3;          // scan every N rows
const EDGE_XSTEP = 1;          // sample every pixel for accuracy at edges
const EDGE_RADIUS = 3;         // how many pixels from a boundary count as "near edge"

const SKIP_WHITE = true;
const WHITE_THRESHOLD = 240;
const AUTO_SEARCH = !IMAGE_PATH;
const TIMING_VALUES = [22, 28, 35, 43];

// ============================================
//   IMAGE LOADING + QUANTIZATION
// ============================================
async function loadAndQuantize(source) {
    let pipeline;
    if (typeof source === 'string') {
        console.log(`[Image] Loading: ${path.resolve(source)}`);
        pipeline = sharp(path.resolve(source));
    } else {
        console.log(`[Image] Loading from buffer...`);
        pipeline = sharp(source);
    }

    // Quantize to fixed palette -- eliminates noisy color transitions
    const quantizedPng = await pipeline
        .resize(CANVAS_W, CANVAS_H, { fit: 'contain', background: '#ffffff' })
        .png({ palette: true, colours: NUM_COLORS, dither: 0 })
        .toBuffer();

    const { data, info } = await sharp(quantizedPng)
        .raw()
        .toBuffer({ resolveWithObject: true });

    console.log(`[Image] Quantized: ${info.width}x${info.height}, ${NUM_COLORS} max colors`);
    return { pixels: data, width: info.width, height: info.height, channels: info.channels };
}

// ============================================
//   PIXEL HELPERS
// ============================================
function getPixel(pixels, width, channels, x, y) {
    const idx = (y * width + x) * channels;
    return { r: pixels[idx], g: pixels[idx + 1], b: pixels[idx + 2] };
}

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function colourDist(a, b) {
    return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function isWhite(c) {
    return c.r >= WHITE_THRESHOLD && c.g >= WHITE_THRESHOLD && c.b >= WHITE_THRESHOLD;
}

// ============================================
//   BUILD NEAR-EDGE MAP
//   Marks pixels within EDGE_RADIUS of a color boundary
// ============================================
function buildEdgeMap(pixels, width, height, channels) {
    // Step 1: find boundary pixels (where any 4-neighbor has different color)
    const boundary = new Uint8Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const c = getPixel(pixels, width, channels, x, y);
            const up = getPixel(pixels, width, channels, x, y - 1);
            const dn = getPixel(pixels, width, channels, x, y + 1);
            const lt = getPixel(pixels, width, channels, x - 1, y);
            const rt = getPixel(pixels, width, channels, x + 1, y);
            if (c.r !== up.r || c.g !== up.g || c.b !== up.b ||
                c.r !== dn.r || c.g !== dn.g || c.b !== dn.b ||
                c.r !== lt.r || c.g !== lt.g || c.b !== lt.b ||
                c.r !== rt.r || c.g !== rt.g || c.b !== rt.b) {
                boundary[y * width + x] = 1;
            }
        }
    }

    // Step 2: dilate by EDGE_RADIUS to mark "near-edge" zone
    const nearEdge = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (boundary[y * width + x]) {
                for (let dy = -EDGE_RADIUS; dy <= EDGE_RADIUS; dy++) {
                    for (let dx = -EDGE_RADIUS; dx <= EDGE_RADIUS; dx++) {
                        const ny = y + dy, nx = x + dx;
                        if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                            nearEdge[ny * width + nx] = 1;
                        }
                    }
                }
            }
        }
    }

    let edgeCount = 0;
    for (let i = 0; i < nearEdge.length; i++) if (nearEdge[i]) edgeCount++;
    console.log(`[Edge] Near-edge zone: ${edgeCount} pixels (${(100 * edgeCount / (width * height)).toFixed(1)}%)`);
    return nearEdge;
}

// ============================================
//   BUILD drawLine MESSAGE
// ============================================
function buildDrawMsg(points, colour, thick) {
    const lines = [];
    for (let i = 0; i < points.length; i++) {
        lines.push(points[i]);
        if ((i + 1) % 3 === 0 && i < points.length - 1) {
            lines.push([TIMING_VALUES[(Math.random() * TIMING_VALUES.length) | 0]]);
        }
    }
    return { a: ["drawLine", { lines, colour: rgbToHex(colour.r, colour.g, colour.b), thick }] };
}

// ============================================
//   SCAN PASS -- generalized row scanner
// ============================================
function scanPass(img, edgeMap, { thick, xStep, yStep, colourThresh, mode }) {
    const messages = [];
    const step = yStep || thick;

    for (let y = 0; y < img.height; y += step) {
        let segColour = null;
        let segPoints = [];

        for (let x = 0; x < img.width; x += xStep) {
            const pixel = getPixel(img.pixels, img.width, img.channels, x, y);
            const isEdge = edgeMap ? edgeMap[y * img.width + x] === 1 : false;

            // Decide if this pixel belongs to this pass
            let skip = false;
            if (SKIP_WHITE && isWhite(pixel)) {
                skip = true;
            } else if (mode === 'fill' && isEdge) {
                // Fill pass skips edge-zone pixels (they'll be redrawn by edge pass)
                skip = true;
            } else if (mode === 'edge' && !isEdge) {
                // Edge pass only draws near-edge pixels
                skip = true;
            }

            if (skip) {
                if (segPoints.length >= 2) messages.push(buildDrawMsg(segPoints, segColour, thick));
                segColour = null; segPoints = [];
                continue;
            }

            if (segColour === null) {
                segColour = pixel; segPoints = [[x, y]];
            } else if (colourDist(pixel, segColour) <= colourThresh) {
                segPoints.push([x, y]);
            } else {
                if (segPoints.length >= 2) messages.push(buildDrawMsg(segPoints, segColour, thick));
                segColour = pixel; segPoints = [[x, y]];
            }
        }
        if (segPoints.length >= 2) messages.push(buildDrawMsg(segPoints, segColour, thick));
    }
    return messages;
}

// ============================================
//   IMAGE TO DRAW MESSAGES (two-pass)
// ============================================
async function imageToDrawMessages(source) {
    const img = await loadAndQuantize(source);

    console.log(`[Process] Building edge map...`);
    const edgeMap = buildEdgeMap(img.pixels, img.width, img.height, img.channels);

    // Pass 1: FILL -- thick brush, covers flat interiors
    const fillStep = FILL_THICK - FILL_OVERLAP;
    console.log(`[Process] Pass 1: Fill (thick=${FILL_THICK}, step=${fillStep}, xStep=${FILL_XSTEP})...`);
    const fillMsgs = scanPass(img, edgeMap, {
        thick: FILL_THICK, xStep: FILL_XSTEP, yStep: fillStep,
        colourThresh: FILL_COLOUR_THRESH, mode: 'fill'
    });
    console.log(`[Process] Fill: ${fillMsgs.length} messages`);

    // Pass 2: EDGE -- thin brush, redraws near boundaries for crisp edges
    console.log(`[Process] Pass 2: Edge (thick=${EDGE_THICK}, step=${EDGE_YSTEP}, xStep=${EDGE_XSTEP})...`);
    const edgeMsgs = scanPass(img, edgeMap, {
        thick: EDGE_THICK, xStep: EDGE_XSTEP, yStep: EDGE_YSTEP,
        colourThresh: 10, mode: 'edge'
    });
    console.log(`[Process] Edge: ${edgeMsgs.length} messages`);

    // Fill first, then edges on top
    const all = [...fillMsgs, ...edgeMsgs];
    console.log(`[Process] Total: ${all.length} messages (fill: ${fillMsgs.length}, edge: ${edgeMsgs.length})`);
    return all;
}

// ============================================
//   GOOGLE IMAGE SEARCH
// ============================================
function searchGoogleImages(query) {
    return new Promise((resolve, reject) => {
        const searchQuery = `${query} colouful drawing clipart`;
        console.log(`[Search] Searching: "${searchQuery}"`);
        gis(searchQuery, (err, results) => {
            if (err) return reject(new Error(`Search failed: ${err.message || err}`));
            if (!results || results.length === 0) return reject(new Error('No results'));
            const valid = results.filter(r => r.url && r.url.startsWith('http') && !r.url.includes('data:') && r.width > 100 && r.height > 100);
            const pick = valid.length > 0 ? valid[0] : results.find(r => r.url && r.url.startsWith('http'));
            if (!pick) return reject(new Error('No valid image URLs'));
            console.log(`[Search] Using: ${pick.url}`);
            resolve(pick.url);
        });
    });
}

function downloadImage(url) {
    return new Promise((resolve, reject) => {
        console.log(`[Download] Fetching...`);
        const request = (targetUrl, redirects = 0) => {
            if (redirects > 5) return reject(new Error('Too many redirects'));
            const client = targetUrl.startsWith('https') ? https : http;
            client.get(targetUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'image/*,*/*' },
                timeout: 10000
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
                    return request(res.headers.location, redirects + 1);
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => { const buf = Buffer.concat(chunks); console.log(`[Download] ${(buf.length / 1024).toFixed(1)} KB`); resolve(buf); });
                res.on('error', reject);
            }).on('error', reject);
        };
        request(url);
    });
}

async function searchAndDownload(word) {
    return await downloadImage(await searchGoogleImages(word));
}

// ============================================
//   SEND MESSAGES
// ============================================
async function sendDraw(ws, messages) {
    console.log(`[Draw] Sending ${messages.length} messages...`);
    for (let i = 0; i < messages.length; i++) {
        if (ws.readyState !== WebSocket.OPEN) { console.log(`[Draw] Disconnected at ${i}`); return; }
        ws.send(JSON.stringify(messages[i]));
        if ((i + 1) % 5 === 0) await new Promise(r => setTimeout(r, 2));
        if ((i + 1) % 100 === 0) console.log(`[Draw] Progress: ${i + 1}/${messages.length}`);
    }
    console.log(`[Draw] ALL ${messages.length} messages sent!`);
}

// ============================================
//   MAIN
// ============================================
async function start() {
    console.log(`
========================================
  Drawasaurus Smart Drawer (Lines Only)
========================================
Room     : "${ROOM_NAME}"
Mode     : ${AUTO_SEARCH ? 'AUTO (Google Image Search)' : `MANUAL ("${IMAGE_PATH}")`}
Colors   : ${NUM_COLORS}
Fill     : thick=${FILL_THICK}, overlap=${FILL_OVERLAP}, xStep=${FILL_XSTEP}
Edge     : thick=${EDGE_THICK}, yStep=${EDGE_YSTEP}, radius=${EDGE_RADIUS}
Canvas   : ${CANVAS_W}x${CANVAS_H}
========================================
`);

    let preloadedMessages = null;
    if (!AUTO_SEARCH) preloadedMessages = await imageToDrawMessages(IMAGE_PATH);

    const wsUrl = `wss://server.drawasaurus.org/room/${encodeURIComponent(ROOM_NAME)}?version=${DRAWASAURUS_VERSION}`;
    console.log(`[+] Connecting to "${ROOM_NAME}"...`);

    const ws = new WebSocket(wsUrl, {
        headers: { 'Origin': 'https://www.drawasaurus.org', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    let drawSent = false;
    let currentWord = null;
    let autoDrawPromise = null;

    ws.on('open', () => {
        console.log('[+] Connected');
        ws.send(JSON.stringify({ a: ["submitUsername", USERNAME] }));
    });

    ws.on('message', async (data) => {
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
                console.log(`[+] In room! ${AUTO_SEARCH ? 'auto-search' : preloadedMessages.length + ' commands ready'}. Waiting for turn...`);
            }
            if (event === 'prepareDrawing') console.log(`[Game] Drawer: "${args[0]}"`);

            if (event === 'showWordPicker') {
                try {
                    const words = JSON.parse(args[0]);
                    currentWord = words[0][0];
                    console.log(`[Game] Picking: "${currentWord}"`);
                    ws.send(JSON.stringify({ a: ["chooseWord", 0] }));
                    if (AUTO_SEARCH) {
                        console.log(`[Auto] Searching for "${currentWord}"...`);
                        autoDrawPromise = (async () => {
                            try {
                                const buf = await searchAndDownload(currentWord);
                                const msgs = await imageToDrawMessages(buf);
                                console.log(`[Auto] Ready: ${msgs.length} commands`);
                                return msgs;
                            } catch (err) {
                                console.log(`[Auto] Failed: ${err.message}`);
                                return null;
                            }
                        })();
                    }
                } catch (e) { }
            }

            if (event === 'youDrawing') {
                console.log(`[Game] youDrawing: "${args[0]}"`);
                if (!drawSent) {
                    drawSent = true;
                    let messages;
                    if (AUTO_SEARCH) {
                        if (autoDrawPromise) { console.log(`[Draw] Waiting for image...`); messages = await autoDrawPromise; }
                    } else { messages = preloadedMessages; }
                    if (messages && messages.length > 0) {
                        console.log(`[Draw] >>> DRAWING (${messages.length} commands) <<<`);
                        await sendDraw(ws, messages);
                    } else console.log(`[Draw] No image available, skipping.`);
                }
            }

            if (event === 'startDrawing') {
                if (!drawSent && (args[0] === USERNAME || args[0]?.startsWith(USERNAME))) {
                    drawSent = true;
                    let messages;
                    if (AUTO_SEARCH && autoDrawPromise) messages = await autoDrawPromise;
                    else if (!AUTO_SEARCH) messages = preloadedMessages;
                    if (messages && messages.length > 0) { console.log(`[Draw] >>> DRAWING (backup) <<<`); await sendDraw(ws, messages); }
                }
            }

            if (event === 'endRound') {
                console.log('[Game] Round ended');
                drawSent = false; autoDrawPromise = null; currentWord = null;
            }

            const silent = ['timerUpdate', 'ping', 'drawLine', 'drawCanvas', 'drawFill',
                'updateUsers', 'setUsername', 'joinedRoom', 'prepareDrawing',
                'showWordPicker', 'startDrawing', 'endRound', 'youDrawing'];
            if (!silent.includes(event)) console.log(`[Event] ${event}: ${JSON.stringify(args).substring(0, 120)}`);
        } catch (err) { }
    });

    ws.on('error', (err) => console.error(`[!] Error: ${err.message}`));
    ws.on('close', () => console.log('[!] Disconnected.'));
    setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ a: ["ping"] })); }, 20000);
    process.on('SIGINT', () => { ws.close(); process.exit(0); });
}

start().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
