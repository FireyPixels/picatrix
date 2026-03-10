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
const ROOM_NAME = 'The Lazy Room';
const USERNAME = 'DaVinci';
const DRAWASAURUS_VERSION = '52a35d2755939386a8de91b399fc0ff770deb697';

const IMAGE_PATH = process.argv[2] || '';
const CANVAS_W = 850;
const CANVAS_H = 750;

// Color quantization (clean, solid color regions)
const NUM_COLORS = 64;

// Pass 1: Fill -- thick brush, region-based space-filling polylines
const FILL_THICK = 9;          // brush size for fill pass
const MIN_REGION_PIXELS = 20;  // ignore regions smaller than this

// Pass 2: Edge -- thin brush, redraws only near color boundaries
const EDGE_THICK = 4;          // increased brush size
const EDGE_YSTEP = 4;          // scan every 4th row (was 3)
const EDGE_XSTEP = 2;          // sample every 2nd pixel (was 1)
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
//   CONNECTED COMPONENT FLOOD FILL
//   Groups pixels into same-color regions
// ============================================
function floodFillRegions(img) {
    const { pixels, width, height, channels } = img;
    const visited = new Uint8Array(width * height);
    const regions = [];

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (visited[idx]) continue;

            const pixel = getPixel(pixels, width, channels, x, y);
            if (SKIP_WHITE && isWhite(pixel)) {
                visited[idx] = 1;
                continue;
            }

            const hex = rgbToHex(pixel.r, pixel.g, pixel.b);
            const regionPixels = [];
            let minX = x, maxX = x, minY = y, maxY = y;

            const queue = [[x, y]];
            let qHead = 0;
            visited[idx] = 1;

            while (qHead < queue.length) {
                const [cx, cy] = queue[qHead++];
                regionPixels.push([cx, cy]);

                if (cx < minX) minX = cx;
                if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy;
                if (cy > maxY) maxY = cy;

                const neighbors = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
                for (const [nx, ny] of neighbors) {
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const nIdx = ny * width + nx;
                    if (visited[nIdx]) continue;

                    const np = getPixel(pixels, width, channels, nx, ny);
                    if (np.r === pixel.r && np.g === pixel.g && np.b === pixel.b) {
                        visited[nIdx] = 1;
                        queue.push([nx, ny]);
                    }
                }
            }

            if (regionPixels.length >= MIN_REGION_PIXELS) {
                regions.push({
                    hex,
                    pixels: regionPixels,
                    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
                });
            }
        }
    }

    console.log(`[Region] Found ${regions.length} color regions (min ${MIN_REGION_PIXELS}px)`);
    return regions;
}

// ============================================
//   MEANDER POLYLINE GENERATOR
//   Creates space-filling polylines that snake through a region.
//   Returns MULTIPLE polylines — breaks whenever the gap between
//   consecutive runs exceeds brush size (avoids painting through
//   non-region areas).
// ============================================
function meanderRegion(region, thick) {
    const { bbox, pixels } = region;
    const step = Math.max(thick - 2, 1);  // overlap slightly for coverage
    const MAX_GAP = thick * 1.5;          // max distance before breaking polyline

    // Build a lookup set for fast membership testing
    const pixelSet = new Set();
    for (const [px, py] of pixels) pixelSet.add(py * 65536 + px);

    const polylines = [];  // array of polylines (each is an array of [x,y])
    let current = [];      // current polyline being built

    function flushCurrent() {
        if (current.length >= 2) polylines.push(current);
        current = [];
    }

    // Check distance between last point in current polyline and a new point
    function gapTooLarge(newPt) {
        if (current.length === 0) return false;
        const last = current[current.length - 1];
        const dx = Math.abs(newPt[0] - last[0]);
        const dy = Math.abs(newPt[1] - last[1]);
        return (dx > MAX_GAP || dy > MAX_GAP);
    }

    // Decide scan direction: scan along the LONGER axis
    const scanHorizontal = bbox.w >= bbox.h;

    if (scanHorizontal) {
        let rowIdx = 0;
        for (let y = bbox.y; y <= bbox.y + bbox.h - 1; y += step) {
            const goRight = (rowIdx % 2 === 0);
            const runs = [];

            let runStart = -1;
            for (let x = bbox.x; x <= bbox.x + bbox.w - 1; x++) {
                const inRegion = pixelSet.has(y * 65536 + x);
                if (inRegion && runStart === -1) {
                    runStart = x;
                } else if (!inRegion && runStart !== -1) {
                    runs.push([runStart, x - 1]);
                    runStart = -1;
                }
            }
            if (runStart !== -1) runs.push([runStart, bbox.x + bbox.w - 1]);

            if (runs.length === 0) { rowIdx++; continue; }

            if (!goRight) runs.reverse();

            for (const [rs, re] of runs) {
                // Determine the two endpoints for this run
                const startPt = goRight ? [rs, y] : [re, y];
                const endPt = (re > rs) ? (goRight ? [re, y] : [rs, y]) : null;

                // Check if we need to break before adding this run
                if (gapTooLarge(startPt)) {
                    flushCurrent();
                }

                current.push(startPt);
                if (endPt) current.push(endPt);
            }
            rowIdx++;
        }
    } else {
        let colIdx = 0;
        for (let x = bbox.x; x <= bbox.x + bbox.w - 1; x += step) {
            const goDown = (colIdx % 2 === 0);
            const runs = [];

            let runStart = -1;
            for (let y = bbox.y; y <= bbox.y + bbox.h - 1; y++) {
                const inRegion = pixelSet.has(y * 65536 + x);
                if (inRegion && runStart === -1) {
                    runStart = y;
                } else if (!inRegion && runStart !== -1) {
                    runs.push([runStart, y - 1]);
                    runStart = -1;
                }
            }
            if (runStart !== -1) runs.push([runStart, bbox.y + bbox.h - 1]);

            if (runs.length === 0) { colIdx++; continue; }

            if (!goDown) runs.reverse();

            for (const [rs, re] of runs) {
                const startPt = goDown ? [x, rs] : [x, re];
                const endPt = (re > rs) ? (goDown ? [x, re] : [x, rs]) : null;

                if (gapTooLarge(startPt)) {
                    flushCurrent();
                }

                current.push(startPt);
                if (endPt) current.push(endPt);
            }
            colIdx++;
        }
    }

    flushCurrent();
    return polylines;
}

// ============================================
//   REGION-BASED FILL PASS
//   Flood fills regions, then generates space-filling polylines
// ============================================
function regionFillPass(img) {
    const regions = floodFillRegions(img);
    const messages = [];

    // Sort regions largest first — big strokes draw first for visual impact
    regions.sort((a, b) => b.pixels.length - a.pixels.length);

    for (const region of regions) {
        const polylines = meanderRegion(region, FILL_THICK);

        for (const polyline of polylines) {
            if (polyline.length < 2) continue;

            // Slice polyline into messages of COORDS_PER_MSG points each
            for (let i = 0; i < polyline.length; i += COORDS_PER_MSG) {
                const slice = polyline.slice(i, Math.min(i + COORDS_PER_MSG, polyline.length));
                if (slice.length < 2) continue;
                messages.push(buildDrawMsg(slice, region.hex, FILL_THICK));
            }
        }
    }

    console.log(`[Fill] ${regions.length} regions → ${messages.length} messages`);
    return messages;
}

// ============================================
//   SCAN PASS -- serpentine scan, endpoint-only segments
//   Used for EDGE pass only (thin brush near boundaries)
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
//   GREEDY POLYLINE PACKING
//   Instead of looking only at the very next segment, finds
//   the closest available segment of a similar color to chain.
//   This drastically reduces messages for edges since row-scanned
//   segments are not strictly contiguous in the array.
// ============================================
const COORDS_PER_MSG = 200;
const COLOR_MERGE_DIST = 45;  // max color distance to merge (0-441 range)

function greedyPack(segments, thick) {
    const MAX_JUMP = thick * 5;
    const messages = [];

    // Make a copy of remaining segments
    const remaining = [...segments];

    while (remaining.length > 0) {
        // Pop the first segment to start a new chain
        const firstSeg = remaining.shift();
        const currentChain = [...firstSeg.points];
        let curHex = firstSeg.hex;

        let added = true;
        while (added) {
            added = false;
            let bestIndex = -1;
            let bestDist = MAX_JUMP * 2 + 1;
            let reverseSeg = false;

            const pEnd = currentChain[currentChain.length - 1];

            for (let i = 0; i < remaining.length; i++) {
                const seg = remaining[i];
                // Allow chaining if colors are SIMILAR (not just identical)
                const colorClose = (seg.hex === curHex) || (hexDist(seg.hex, curHex) <= COLOR_MERGE_DIST);
                if (!colorClose) continue;

                // Check distance to segment start
                const pSegStart = seg.points[0];
                const dx1 = Math.abs(pSegStart[0] - pEnd[0]);
                const dy1 = Math.abs(pSegStart[1] - pEnd[1]);
                if (dx1 <= MAX_JUMP && dy1 <= MAX_JUMP) {
                    const dist = dx1 + dy1;
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIndex = i;
                        reverseSeg = false;
                    }
                }

                // Check distance to segment end (can draw backwards)
                const pSegEnd = seg.points[seg.points.length - 1];
                const dx2 = Math.abs(pSegEnd[0] - pEnd[0]);
                const dy2 = Math.abs(pSegEnd[1] - pEnd[1]);
                if (dx2 <= MAX_JUMP && dy2 <= MAX_JUMP) {
                    const dist = dx2 + dy2;
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIndex = i;
                        reverseSeg = true;
                    }
                }
            }

            if (bestIndex !== -1) {
                const nextSeg = remaining[bestIndex];
                const ptsToAdd = reverseSeg ? [...nextSeg.points].reverse() : nextSeg.points;
                
                // Avoid duplicating the connection coordinate if it entirely overlaps
                if (ptsToAdd.length > 0) {
                    const p1 = currentChain[currentChain.length - 1];
                    const p2 = ptsToAdd[0];
                    if (p1[0] === p2[0] && p1[1] === p2[1]) {
                        ptsToAdd.shift(); // remove overlapping first point
                    }
                }

                currentChain.push(...ptsToAdd);
                remaining.splice(bestIndex, 1);
                added = true;
            }
        }

        // Slice chain into chunks fitting Drawasaurus constraints
        if (currentChain.length >= 2) {
            for (let i = 0; i < currentChain.length; i += COORDS_PER_MSG) {
                // If we slice in middle, duplicate the connecting point to next slice
                // So slice from i to i + COORDS_PER_MSG
                const slice = currentChain.slice(i, Math.min(i + COORDS_PER_MSG, currentChain.length));
                // To keep lines continuous, we should step by COORDS_PER_MSG - 1, but for simplicity
                // slice without overlap is fine, though drawing might have tiny 1px gaps at cuts.
                if (slice.length >= 2) {
                    messages.push(buildDrawMsg(slice, curHex, thick));
                }
            }
        }
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

    // Pass 1: FILL -- thick brush, region-based space-filling polylines
    console.log(`[Process] Pass 1: Region Fill (thick=${FILL_THICK})...`);
    const fillMsgs = regionFillPass(img);

    // Pass 2: EDGE -- thin brush, redraws near boundaries for crisp edges
    console.log(`[Process] Pass 2: Edge (thick=${EDGE_THICK}, step=${EDGE_YSTEP}, xStep=${EDGE_XSTEP})...`);
    const edgeSegs = scanPass(img, edgeMap, {
        thick: EDGE_THICK, xStep: EDGE_XSTEP, yStep: EDGE_YSTEP,
        colourThresh: 10, mode: 'edge'
    });
    const edgeMsgs = greedyPack(edgeSegs, EDGE_THICK);
    console.log(`[Process] Edge: ${edgeSegs.length} segments → ${edgeMsgs.length} messages`);

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
//   MAIN WEBSOCKET LOGIC
// ============================================
let reconnectAttempts = 0;
const MAX_RECONNECTS = 10;
let ws = null;
let rl = null;

async function initConnection(preloadedMessages) {
    return new Promise((resolve, reject) => {
        const wsUrl = `wss://server.drawasaurus.org/room/${encodeURIComponent(ROOM_NAME)}?version=${DRAWASAURUS_VERSION}`;
        console.log(`[+] Connecting to "${ROOM_NAME}" (Attempt ${reconnectAttempts + 1})...`);

        ws = new WebSocket(wsUrl, {
            headers: { 'Origin': 'https://www.drawasaurus.org', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        let drawSent = false;
        let currentWord = null;
        let autoDrawPromise = null;

        const resetState = () => {
            drawSent = false;
            autoDrawPromise = null;
            currentWord = null;
        };

        ws.on('open', () => {
            console.log('[+] Connected');
            reconnectAttempts = 0;
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
                console.log(`[+] In room! ${AUTO_SEARCH ? 'auto-search' : (preloadedMessages ? preloadedMessages.length : 0) + ' commands ready'}. Waiting for turn...`);
            }
            if (event === 'prepareDrawing') {
                console.log(`[Game] Drawer: "${args[0]}"`);
                resetState();
            }
            if (event === 'startingGame' || event === 'practiceMode') {
                resetState();
            }

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
                resetState();
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

            // Ping isn't technically silent, we manage heartbeats
            const silent = ['timerUpdate', 'ping', 'drawLine', 'drawCanvas', 'drawFill',
                'updateUsers', 'setUsername', 'joinedRoom', 'prepareDrawing',
                'showWordPicker', 'startDrawing', 'endRound', 'youDrawing',
                'connect', 'requestUsername', 'setSession', 'fillCanvas',
                'skipPlayer', 'updateRound', 'userCorrect', 'revealLetter',
                'undoLines', 'startingGame', 'practiceMode'];
            if (!silent.includes(event)) console.log(`[Event] ${event}: ${JSON.stringify(args).substring(0, 120)}`);
        } catch (err) { }
    });

    ws.on('error', (err) => {
        console.error(`[!] Error: ${err.message}`);
    });

    ws.on('close', () => {
        console.log('[!] Disconnected.');
        resolve(false); // resolve false means reconnect
    });

    const pingInterval = setInterval(() => { 
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ a: ["ping"] })); 
    }, 20000);

    // Initial RL setup if not done
    if (!rl) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
        rl.on('line', (line) => {
            const msg = line.trim();
            if (!msg) return;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ a: ["chat", msg] }));
                console.log(`[Chat] You: ${msg}`);
            } else {
                console.log(`[Chat] Not connected, can't send.`);
            }
        });
        process.on('SIGINT', () => { rl.close(); if(ws) ws.close(); process.exit(0); });
    }

    // Cleanup interval on disconnect
    ws.on('close', () => clearInterval(pingInterval));
  });
}

async function start() {
    console.log('\n========================================');
    console.log('  Drawasaurus Smart Drawer (Lines Only)');
    console.log('========================================');
    console.log(`Room     : "${ROOM_NAME}"`);
    console.log(`Mode     : AUTO (Google Image Search)`);
    console.log(`Colors   : ${NUM_COLORS}`);
    console.log(`Fill     : thick=${FILL_THICK}, minRegion=${MIN_REGION_PIXELS}`);
    console.log(`Edge     : thick=${EDGE_THICK}, radius=${EDGE_RADIUS}`);

    // Parse timing args if present
    for (const arg of process.argv) {
        if (arg.startsWith('--timing=')) {
            const vals = arg.split('=')[1].split(',').map(n => parseInt(n));
            if (vals.length === 4) {
                TIMING_VALUES[0] = vals[0];
                TIMING_VALUES[1] = vals[1];
                TIMING_VALUES[2] = vals[2];
                TIMING_VALUES[3] = vals[3];
            }
        }
    }
    console.log(`Canvas   : ${CANVAS_W}x${CANVAS_H}`);
    console.log('========================================\n');

    let preloadedMessages = null;
    if (!AUTO_SEARCH) preloadedMessages = await imageToDrawMessages(IMAGE_PATH);

    while (reconnectAttempts < MAX_RECONNECTS) {
        const connected = await initConnection(preloadedMessages);
        if (connected) break; // Should not reach here ordinarily unless graceful exit
        
        reconnectAttempts++;
        if (reconnectAttempts < MAX_RECONNECTS) {
            console.log(`[!] Reconnecting in 3 seconds...`);
            await new Promise(r => setTimeout(r, 3000));
        } else {
            console.error('[!] Maximum reconnect attempts reached. Exiting.');
            process.exit(1);
        }
    }
}

start().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
