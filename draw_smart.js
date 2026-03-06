const WebSocket = require('ws');
const sharp = require('sharp');
const path = require('path');
const https = require('https');
const http = require('http');
const gis = require('g-i-s');
const readline = require('readline');

// ============================================
//   CONFIGURATION
// ============================================
const ROOM_NAME = 'The Boring Room';
const USERNAME = 'DaVinci';
const DRAWASAURUS_VERSION = '52a35d2755939386a8de91b399fc0ff770deb697';

const IMAGE_PATH = process.argv[2] || '';
const CANVAS_W = 880;
const CANVAS_H = 750;

// Color quantization (clean, solid color regions)
const NUM_COLORS = 16;

// Pass 1: Fill -- thick brush, covers large areas fast
const FILL_THICK = 9;          // brush size for fill pass
const FILL_OVERLAP = 2;        // rows of overlap between scan lines
const FILL_XSTEP = 2;          // sample every N pixels horizontally
const FILL_COLOUR_THRESH = 20; // merge threshold within quantized palette

// Pass 2: Edge -- thin brush, redraws only near color boundaries
const EDGE_THICK = 3;          // brush size for edge pass
const EDGE_YSTEP = 3;          // scan every N rows
const EDGE_XSTEP = 1;          // sample every pixel for accuracy
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

// Distance between two hex color strings (e.g. "#ff0000")
function hexDist(hex1, hex2) {
    const r1 = parseInt(hex1.slice(1, 3), 16), g1 = parseInt(hex1.slice(3, 5), 16), b1 = parseInt(hex1.slice(5, 7), 16);
    const r2 = parseInt(hex2.slice(1, 3), 16), g2 = parseInt(hex2.slice(3, 5), 16), b2 = parseInt(hex2.slice(5, 7), 16);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
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
function buildDrawMsg(points, hexColour, thick) {
    const lines = [];
    for (let i = 0; i < points.length; i++) {
        lines.push(points[i]);
        if ((i + 1) % 3 === 0 && i < points.length - 1) {
            lines.push([TIMING_VALUES[(Math.random() * TIMING_VALUES.length) | 0]]);
        }
    }
    return { a: ["drawLine", { lines, colour: hexColour, thick }] };
}

// ============================================
//   SCAN PASS -- serpentine scan, endpoint-only segments
//   Each same-color horizontal run is stored as just [start, end]
//   since the server draws a straight line between them anyway.
//   Alternates direction per row for natural zigzag chaining.
// ============================================
function scanPass(img, edgeMap, { thick, xStep, yStep, colourThresh, mode }) {
    const segments = [];
    const step = yStep || thick;
    let rowIndex = 0;

    for (let y = 0; y < img.height; y += step) {
        let segColour = null;
        let segStart = null;
        let segEnd = null;

        // Serpentine: even rows left→right, odd rows right→left
        const goRight = (rowIndex % 2 === 0);
        const xStart = goRight ? 0 : img.width - 1;
        const xEnd = goRight ? img.width : -1;
        const xDir = goRight ? xStep : -xStep;

        for (let x = xStart; x !== xEnd && (goRight ? x < img.width : x >= 0); x += xDir) {
            const pixel = getPixel(img.pixels, img.width, img.channels, x, y);
            const isEdge = edgeMap ? edgeMap[y * img.width + x] === 1 : false;

            let skip = false;
            if (SKIP_WHITE && isWhite(pixel)) {
                skip = true;
            } else if (mode === 'fill' && isEdge) {
                skip = true;
            } else if (mode === 'edge' && !isEdge) {
                skip = true;
            }

            if (skip) {
                // Flush current segment (only if it spans at least 2 sample points)
                if (segStart && (segStart[0] !== segEnd[0])) {
                    segments.push({ hex: rgbToHex(segColour.r, segColour.g, segColour.b), points: [segStart, segEnd] });
                }
                segColour = null; segStart = null; segEnd = null;
                continue;
            }

            if (segColour === null) {
                segColour = pixel;
                segStart = [x, y];
                segEnd = [x, y];
            } else if (colourDist(pixel, segColour) <= colourThresh) {
                // Extend the run — just update the end point
                segEnd = [x, y];
            } else {
                // Color changed — flush and start new
                if (segStart && (segStart[0] !== segEnd[0])) {
                    segments.push({ hex: rgbToHex(segColour.r, segColour.g, segColour.b), points: [segStart, segEnd] });
                }
                segColour = pixel;
                segStart = [x, y];
                segEnd = [x, y];
            }
        }
        // Flush end of row
        if (segStart && (segStart[0] !== segEnd[0])) {
            segments.push({ hex: rgbToHex(segColour.r, segColour.g, segColour.b), points: [segStart, segEnd] });
        }
        rowIndex++;
    }
    return segments;
}

// ============================================
//   ZIGZAG FILL PASS -- diagonal zigzag strokes (↗↘↗↘)
//   Covers BAND_ROWS scan rows per stroke. One zigzag polyline
//   replaces multiple horizontal lines. Small holes are OK.
// ============================================
const FILL_BAND_ROWS = 2;   // combine 2 scan rows per zigzag (7px height — 9px brush covers gaps)
const ZIG_WIDTH = 12;        // tight teeth — perpendicular gap ~6px < 9px brush

function makeZigzag(xStart, xEnd, yTop, yBot) {
    const points = [];
    let atTop = true;
    // Generate zigzag teeth from xStart to xEnd
    for (let x = xStart; x <= xEnd; x += ZIG_WIDTH) {
        points.push([x, atTop ? yTop : yBot]);
        atTop = !atTop;
    }
    // Make sure we reach xEnd
    if (points.length > 0 && points[points.length - 1][0] !== xEnd) {
        points.push([xEnd, atTop ? yTop : yBot]);
    }
    return points;
}

function zigzagFillPass(img, edgeMap) {
    const segments = [];
    const step = FILL_THICK - FILL_OVERLAP;
    const bandStep = step * FILL_BAND_ROWS; // vertical distance between band starts
    const bandHeight = step * (FILL_BAND_ROWS - 1); // y-range covered by one band

    for (let bandY = 0; bandY < img.height; bandY += bandStep) {
        const yTop = bandY;
        const yBot = Math.min(bandY + bandHeight, img.height - 1);
        const ySample = Math.min(bandY + step, img.height - 1); // sample color at middle row

        let segColour = null;
        let segStartX = -1;
        let segEndX = -1;

        for (let x = 0; x < img.width; x += FILL_XSTEP) {
            const pixel = getPixel(img.pixels, img.width, img.channels, x, ySample);
            const isEdge = edgeMap[ySample * img.width + x] === 1;
            const skip = (SKIP_WHITE && isWhite(pixel)) || isEdge;

            if (skip) {
                if (segStartX >= 0 && segEndX > segStartX) {
                    const pts = makeZigzag(segStartX, segEndX, yTop, yBot);
                    if (pts.length >= 2) {
                        segments.push({ hex: rgbToHex(segColour.r, segColour.g, segColour.b), points: pts });
                    }
                }
                segColour = null; segStartX = -1; segEndX = -1;
                continue;
            }

            if (segColour === null) {
                segColour = pixel; segStartX = x; segEndX = x;
            } else if (colourDist(pixel, segColour) <= FILL_COLOUR_THRESH) {
                segEndX = x;
            } else {
                if (segStartX >= 0 && segEndX > segStartX) {
                    const pts = makeZigzag(segStartX, segEndX, yTop, yBot);
                    if (pts.length >= 2) {
                        segments.push({ hex: rgbToHex(segColour.r, segColour.g, segColour.b), points: pts });
                    }
                }
                segColour = pixel; segStartX = x; segEndX = x;
            }
        }
        // Flush end of band
        if (segStartX >= 0 && segEndX > segStartX) {
            const pts = makeZigzag(segStartX, segEndX, yTop, yBot);
            if (pts.length >= 2) {
                segments.push({ hex: rgbToHex(segColour.r, segColour.g, segColour.b), points: pts });
            }
        }
    }

    return segments;
}

// ============================================
//   ZIGZAG PACKING -- chain nearby segments, merge similar colors
//   Chains spatially close segments; merges colors that are
//   visually similar so more segments combine into fewer messages
// ============================================
const COORDS_PER_MSG = 200;
const COLOR_MERGE_DIST = 35;  // max color distance to merge (0-441 range)

function zigzagPack(segments, thick) {
    const MAX_JUMP = thick * 5;
    const messages = [];
    let curHex = null;
    let coordBuf = [];

    function flush() {
        if (coordBuf.length >= 2) {
            messages.push(buildDrawMsg(coordBuf, curHex, thick));
        }
        coordBuf = [];
    }

    for (const seg of segments) {
        const firstPt = seg.points[0];

        // Decide whether to chain onto the current buffer
        // Allow chaining if colors are SIMILAR (not just identical)
        let chain = false;
        if (curHex && coordBuf.length > 0) {
            const lastPt = coordBuf[coordBuf.length - 1];
            const dx = Math.abs(firstPt[0] - lastPt[0]);
            const dy = Math.abs(firstPt[1] - lastPt[1]);
            const colorClose = (seg.hex === curHex) || (hexDist(seg.hex, curHex) <= COLOR_MERGE_DIST);
            if (colorClose && dx <= MAX_JUMP && dy <= MAX_JUMP) {
                chain = true;
            }
        }

        if (!chain) {
            flush();
            curHex = seg.hex;
        }

        // Append this segment's points to the buffer
        for (const pt of seg.points) {
            coordBuf.push(pt);
            if (coordBuf.length >= COORDS_PER_MSG) {
                messages.push(buildDrawMsg(coordBuf, curHex, thick));
                coordBuf = [pt];
            }
        }
    }

    flush();
    return messages;
}

// ============================================
//   IMAGE TO DRAW MESSAGES (two-pass + zigzag packing)
// ============================================
async function imageToDrawMessages(source) {
    const img = await loadAndQuantize(source);

    console.log(`[Process] Building edge map...`);
    const edgeMap = buildEdgeMap(img.pixels, img.width, img.height, img.channels);

    // Pass 1: FILL -- thick brush, serpentine horizontal strokes
    const fillStep = FILL_THICK - FILL_OVERLAP;
    console.log(`[Process] Pass 1: Fill (thick=${FILL_THICK}, step=${fillStep}, xStep=${FILL_XSTEP})...`);
    const fillSegs = scanPass(img, edgeMap, {
        thick: FILL_THICK, xStep: FILL_XSTEP, yStep: fillStep,
        colourThresh: FILL_COLOUR_THRESH, mode: 'fill'
    });
    const fillMsgs = zigzagPack(fillSegs, FILL_THICK);
    console.log(`[Process] Fill: ${fillSegs.length} segments → ${fillMsgs.length} messages`);

    // Pass 2: EDGE -- thin brush, redraws near boundaries for crisp edges
    console.log(`[Process] Pass 2: Edge (thick=${EDGE_THICK}, step=${EDGE_YSTEP}, xStep=${EDGE_XSTEP})...`);
    const edgeSegs = scanPass(img, edgeMap, {
        thick: EDGE_THICK, xStep: EDGE_XSTEP, yStep: EDGE_YSTEP,
        colourThresh: 10, mode: 'edge'
    });
    const edgeMsgs = zigzagPack(edgeSegs, EDGE_THICK);
    console.log(`[Process] Edge: ${edgeSegs.length} segments → ${edgeMsgs.length} messages`);

    // Fill first, then edges on top — then sort by path length (longest first)
    const all = [...fillMsgs, ...edgeMsgs];

    // Sort by total path distance (decreasing) — big strokes draw first
    // This makes the drawing look dynamic instead of boring top-to-bottom
    function msgPathLen(msg) {
        const coords = msg.a[1].lines.filter(l => l.length === 2); // skip timing values [t]
        let dist = 0;
        for (let i = 1; i < coords.length; i++) {
            dist += Math.abs(coords[i][0] - coords[i - 1][0]) + Math.abs(coords[i][1] - coords[i - 1][1]);
        }
        return dist;
    }
    all.sort((a, b) => msgPathLen(b) - msgPathLen(a));

    console.log(`[Process] Total: ${all.length} messages (fill: ${fillMsgs.length}, edge: ${edgeMsgs.length})`);
    return all;
}

// ============================================
//   GOOGLE IMAGE SEARCH
// ============================================
function searchGoogleImages(query) {
    return new Promise((resolve, reject) => {
        const searchQuery = `${query} clipart`;
        console.log(`[Search] Searching: "${searchQuery}"`);
        gis(searchQuery, (err, results) => {
            if (err) return reject(new Error(`Search failed: ${err.message || err}`));
            if (!results || results.length === 0) return reject(new Error('No results'));
            const valid = results.filter(r => r.url && r.url.startsWith('http') && !r.url.includes('data:') && r.width > 100 && r.height > 100);
            if (valid.length === 0) return reject(new Error('No valid image URLs'));
            console.log(`[Search] Found ${valid.length} candidate images`);
            resolve(valid.map(r => r.url));
        });
    });
}

function downloadImage(url) {
    return new Promise((resolve, reject) => {
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
    const urls = await searchGoogleImages(word);
    for (let i = 0; i < urls.length; i++) {
        try {
            console.log(`[Download] Trying image ${i + 1}/${urls.length}: ${urls[i].substring(0, 80)}...`);
            const buf = await downloadImage(urls[i]);
            return buf;
        } catch (err) {
            console.log(`[Download] Image ${i + 1} failed: ${err.message}, trying next...`);
        }
    }
    throw new Error('All image downloads failed');
}

// ============================================
//   SEND MESSAGES
// ============================================
async function sendDraw(ws, messages) {
    console.log(`[Draw] Sending ${messages.length} messages...`);
    for (let i = 0; i < messages.length; i++) {
        if (ws.readyState !== WebSocket.OPEN) { console.log(`[Draw] Disconnected at ${i}`); return; }
        ws.send(JSON.stringify(messages[i]));
        if ((i + 1) % 3 === 0) await new Promise(r => setTimeout(r, 4));
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

            // Show chat messages from others
            if (event === 'chatUser') {
                console.log(`[Chat] ${args[1]}: ${args[0]}`);
                return;
            }

            if (event === 'chatNotification') {
                console.log(`[Chat] * ${args[0]}`);
                return;
            }

            const silent = ['timerUpdate', 'ping', 'drawLine', 'drawCanvas', 'drawFill',
                'updateUsers', 'setUsername', 'joinedRoom', 'prepareDrawing',
                'showWordPicker', 'startDrawing', 'endRound', 'youDrawing',
                'connect', 'requestUsername', 'setSession', 'fillCanvas',
                'skipPlayer', 'updateRound', 'userCorrect', 'revealLetter',
                'undoLines'];
            if (!silent.includes(event)) console.log(`[Event] ${event}: ${JSON.stringify(args).substring(0, 120)}`);
        } catch (err) { }
    });

    ws.on('error', (err) => console.error(`[!] Error: ${err.message}`));
    ws.on('close', () => console.log('[!] Disconnected.'));
    setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ a: ["ping"] })); }, 20000);

    // ============================================
    //   TERMINAL CHAT INPUT
    // ============================================
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
    rl.on('line', (line) => {
        const msg = line.trim();
        if (!msg) return;
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ a: ["chat", msg] }));
            console.log(`[Chat] You: ${msg}`);
        } else {
            console.log(`[Chat] Not connected, can't send.`);
        }
    });

    process.on('SIGINT', () => { rl.close(); ws.close(); process.exit(0); });
}

start().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
