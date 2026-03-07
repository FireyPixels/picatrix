// ==UserScript==
// @name         Drawasaurus DropDraw
// @namespace    drawasaurus-dropdraw
// @version      1.0
// @description  Drag & drop any image onto Drawasaurus to auto-draw it during your turn
// @match        https://www.drawasaurus.org/*
// @match        https://drawasaurus.org/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ============================================
    //   CONFIGURATION (matches davinci.js)
    // ============================================
    const CANVAS_W = 880;
    const CANVAS_H = 750;

    const NUM_COLORS = 16;
    const FILL_THICK = 9;
    const MIN_REGION_PIXELS = 20;

    const EDGE_THICK = 4;
    const EDGE_YSTEP = 4;
    const EDGE_XSTEP = 2;
    const EDGE_RADIUS = 3;

    const SKIP_WHITE = true;
    const WHITE_THRESHOLD = 240;

    const LOG_PREFIX = '[DrawDrop]';
    const log = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);

    // ============================================
    //   WEBSOCKET HOOK
    // ============================================
    let gameSocket = null;

    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function (...args) {
        const ws = new OriginalWebSocket(...args);
        if (typeof args[0] === 'string' && args[0].includes('drawasaurus.org/room')) {
            gameSocket = ws;
            log('Captured game WebSocket!', args[0]);
            ws.addEventListener('close', () => {
                if (gameSocket === ws) {
                    gameSocket = null;
                    log('Game WebSocket closed');
                }
            });
        }
        return ws;
    };
    // Preserve prototype chain
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

    // ============================================
    //   DRAG & DROP OVERLAY (injected after DOM ready)
    // ============================================
    function injectUI() {
        // --- Overlay ---
        const overlay = document.createElement('div');
        overlay.id = 'dropdraw-overlay';
        overlay.innerHTML = `
            <div id="dropdraw-inner">
                <div id="dropdraw-icon">Drop Image</div>
                <div id="dropdraw-text">Drop image to draw</div>
            </div>
        `;
        document.body.appendChild(overlay);

        // --- Status badge ---
        const badge = document.createElement('div');
        badge.id = 'dropdraw-badge';
        badge.textContent = 'DropDraw Ready';
        document.body.appendChild(badge);

        // --- Styles ---
        const style = document.createElement('style');
        style.textContent = `
            #dropdraw-overlay {
                display: none;
                position: fixed; inset: 0;
                background: rgba(0, 0, 0, 0.55);
                z-index: 999999;
                justify-content: center; align-items: center;
                pointer-events: none;
                backdrop-filter: blur(4px);
            }
            #dropdraw-overlay.active {
                display: flex;
            }
            #dropdraw-inner {
                text-align: center; color: #fff;
                padding: 40px 60px;
                border: 3px dashed rgba(255,255,255,0.6);
                border-radius: 20px;
                background: rgba(255,255,255,0.08);
            }
            #dropdraw-icon { font-size: 64px; margin-bottom: 12px; }
            #dropdraw-text { font-size: 22px; font-weight: 600; }

            #dropdraw-badge {
                position: fixed; bottom: 14px; right: 14px;
                background: #1a1a2e; color: #eee;
                font-size: 13px; font-weight: 600;
                padding: 7px 14px; border-radius: 8px;
                z-index: 999998; opacity: 0.85;
                box-shadow: 0 2px 10px rgba(0,0,0,0.4);
                transition: background 0.3s, opacity 0.3s;
                font-family: system-ui, sans-serif;
            }
            #dropdraw-badge.sending {
                background: #e67e22; color: #fff; opacity: 1;
            }
            #dropdraw-badge.done {
                background: #27ae60; color: #fff; opacity: 1;
            }
            #dropdraw-badge.error {
                background: #c0392b; color: #fff; opacity: 1;
            }
        `;
        document.head.appendChild(style);

        return { overlay, badge };
    }

    // ============================================
    //   IMAGE PROCESSING (Davinci Algorithm Port)
    // ============================================
    function rgbToHex(r, g, b) {
        return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    }

    function getPixel(data, width, x, y) {
        const idx = (y * width + x) * 4;
        return { r: data[idx], g: data[idx + 1], b: data[idx + 2], a: data[idx + 3] };
    }

    function colourDist(a, b) {
        return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
    }

    function hexDist(hex1, hex2) {
        const r1 = parseInt(hex1.slice(1, 3), 16), g1 = parseInt(hex1.slice(3, 5), 16), b1 = parseInt(hex1.slice(5, 7), 16);
        const r2 = parseInt(hex2.slice(1, 3), 16), g2 = parseInt(hex2.slice(3, 5), 16), b2 = parseInt(hex2.slice(5, 7), 16);
        return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
    }

    function isWhite(c) {
        return (c.a < 128) || (c.r >= WHITE_THRESHOLD && c.g >= WHITE_THRESHOLD && c.b >= WHITE_THRESHOLD);
    }

    function buildDrawMsg(points, hexColour, thick) {
        const TIMING_VALUES = [22, 28, 35, 43];
        const lines = [];
        for (let i = 0; i < points.length; i++) {
            lines.push(points[i]);
            if ((i + 1) % 3 === 0 && i < points.length - 1) {
                lines.push([TIMING_VALUES[(Math.random() * TIMING_VALUES.length) | 0]]);
            }
        }
        return { a: ["drawLine", { lines, colour: hexColour, thick }] };
    }

    // Fast browser-based quantization (Posterization)
    function applyPosterize(data, levels) {
        const step = 255 / (levels - 1);
        for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.round(data[i] / step) * step;
            data[i + 1] = Math.round(data[i + 1] / step) * step;
            data[i + 2] = Math.round(data[i + 2] / step) * step;
        }
    }

    function buildEdgeMap(data, width, height) {
        const boundary = new Uint8Array(width * height);
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const c = getPixel(data, width, x, y);
                if (isWhite(c)) continue;
                const up = getPixel(data, width, x, y - 1);
                const dn = getPixel(data, width, x, y + 1);
                const lt = getPixel(data, width, x - 1, y);
                const rt = getPixel(data, width, x + 1, y);
                if (c.r !== up.r || c.g !== up.g || c.b !== up.b ||
                    c.r !== dn.r || c.g !== dn.g || c.b !== dn.b ||
                    c.r !== lt.r || c.g !== lt.g || c.b !== lt.b ||
                    c.r !== rt.r || c.g !== rt.g || c.b !== rt.b) {
                    boundary[y * width + x] = 1;
                }
            }
        }
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
        return nearEdge;
    }

    function floodFillRegions(data, width, height) {
        const visited = new Uint8Array(width * height);
        const regions = [];

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (visited[idx]) continue;

                const pixel = getPixel(data, width, x, y);
                if (SKIP_WHITE && isWhite(pixel)) { visited[idx] = 1; continue; }

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
                        const np = getPixel(data, width, nx, ny);
                        if (np.r === pixel.r && np.g === pixel.g && np.b === pixel.b) {
                            visited[nIdx] = 1;
                            queue.push([nx, ny]);
                        }
                    }
                }
                if (regionPixels.length >= MIN_REGION_PIXELS) {
                    regions.push({ hex, pixels: regionPixels, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } });
                }
            }
        }
        return regions;
    }

    function meanderRegion(region, thick) {
        const { bbox, pixels } = region;
        const step = Math.max(thick - 2, 1);
        const MAX_GAP = thick * 1.5;
        const pixelSet = new Set();
        for (const [px, py] of pixels) pixelSet.add(py * 65536 + px);

        const polylines = [];
        let current = [];

        function flushCurrent() {
            if (current.length >= 2) polylines.push(current);
            current = [];
        }

        function gapTooLarge(newPt) {
            if (current.length === 0) return false;
            const last = current[current.length - 1];
            return (Math.abs(newPt[0] - last[0]) > MAX_GAP || Math.abs(newPt[1] - last[1]) > MAX_GAP);
        }

        if (bbox.w >= bbox.h) {
            let rowIdx = 0;
            for (let y = bbox.y; y <= bbox.y + bbox.h - 1; y += step) {
                const goRight = (rowIdx % 2 === 0);
                const runs = [];
                let runStart = -1;
                for (let x = bbox.x; x <= bbox.x + bbox.w - 1; x++) {
                    const inRegion = pixelSet.has(y * 65536 + x);
                    if (inRegion && runStart === -1) runStart = x;
                    else if (!inRegion && runStart !== -1) { runs.push([runStart, x - 1]); runStart = -1; }
                }
                if (runStart !== -1) runs.push([runStart, bbox.x + bbox.w - 1]);
                if (runs.length === 0) { rowIdx++; continue; }
                if (!goRight) runs.reverse();
                for (const [rs, re] of runs) {
                    const startPt = goRight ? [rs, y] : [re, y];
                    const endPt = (re > rs) ? (goRight ? [re, y] : [rs, y]) : null;
                    if (gapTooLarge(startPt)) flushCurrent();
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
                    if (inRegion && runStart === -1) runStart = y;
                    else if (!inRegion && runStart !== -1) { runs.push([runStart, y - 1]); runStart = -1; }
                }
                if (runStart !== -1) runs.push([runStart, bbox.y + bbox.h - 1]);
                if (runs.length === 0) { colIdx++; continue; }
                if (!goDown) runs.reverse();
                for (const [rs, re] of runs) {
                    const startPt = goDown ? [x, rs] : [x, re];
                    const endPt = (re > rs) ? (goDown ? [x, re] : [x, rs]) : null;
                    if (gapTooLarge(startPt)) flushCurrent();
                    current.push(startPt);
                    if (endPt) current.push(endPt);
                }
                colIdx++;
            }
        }
        flushCurrent();
        return polylines;
    }

    function regionFillPass(data, width, height) {
        const regions = floodFillRegions(data, width, height);
        const messages = [];
        regions.sort((a, b) => b.pixels.length - a.pixels.length);
        for (const region of regions) {
            const polylines = meanderRegion(region, FILL_THICK);
            for (const polyline of polylines) {
                if (polyline.length < 2) continue;
                for (let i = 0; i < polyline.length; i += 200) {
                    const slice = polyline.slice(i, Math.min(i + 200, polyline.length));
                    if (slice.length >= 2) messages.push(buildDrawMsg(slice, region.hex, FILL_THICK));
                }
            }
        }
        return messages;
    }

    function scanPass(data, width, height, edgeMap, { thick, xStep, yStep, colourThresh, mode }) {
        const segments = [];
        const step = yStep || thick;
        let rowIndex = 0;

        for (let y = 0; y < height; y += step) {
            let segColour = null, segStart = null, segEnd = null;
            const goRight = (rowIndex % 2 === 0);
            const xStart = goRight ? 0 : width - 1;
            const xEnd = goRight ? width : -1;
            const xDir = goRight ? xStep : -xStep;

            for (let x = xStart; x !== xEnd && (goRight ? x < width : x >= 0); x += xDir) {
                const pixel = getPixel(data, width, x, y);
                const isEdge = edgeMap ? edgeMap[y * width + x] === 1 : false;

                let skip = false;
                if (SKIP_WHITE && isWhite(pixel)) skip = true;
                else if (mode === 'fill' && isEdge) skip = true;
                else if (mode === 'edge' && !isEdge) skip = true;

                if (skip) {
                    if (segStart && (segStart[0] !== segEnd[0])) {
                        segments.push({ hex: rgbToHex(segColour.r, segColour.g, segColour.b), points: [segStart, segEnd] });
                    }
                    segColour = null; segStart = null; segEnd = null;
                    continue;
                }

                if (segColour === null) {
                    segColour = pixel; segStart = [x, y]; segEnd = [x, y];
                } else if (colourDist(pixel, segColour) <= colourThresh) {
                    segEnd = [x, y];
                } else {
                    if (segStart && (segStart[0] !== segEnd[0])) {
                        segments.push({ hex: rgbToHex(segColour.r, segColour.g, segColour.b), points: [segStart, segEnd] });
                    }
                    segColour = pixel; segStart = [x, y]; segEnd = [x, y];
                }
            }
            if (segStart && (segStart[0] !== segEnd[0])) {
                segments.push({ hex: rgbToHex(segColour.r, segColour.g, segColour.b), points: [segStart, segEnd] });
            }
            rowIndex++;
        }
        return segments;
    }

    function greedyPack(segments, thick) {
        const MAX_JUMP = thick * 5;
        const messages = [];
        const remaining = [...segments];

        while (remaining.length > 0) {
            const firstSeg = remaining.shift();
            const currentChain = [...firstSeg.points];
            let curHex = firstSeg.hex;

            let added = true;
            while (added) {
                added = false;
                let bestIndex = -1, bestDist = MAX_JUMP * 2 + 1, reverseSeg = false;
                const pEnd = currentChain[currentChain.length - 1];

                for (let i = 0; i < remaining.length; i++) {
                    const seg = remaining[i];
                    if (seg.hex !== curHex && hexDist(seg.hex, curHex) > 45) continue;

                    const pSegStart = seg.points[0];
                    const dx1 = Math.abs(pSegStart[0] - pEnd[0]), dy1 = Math.abs(pSegStart[1] - pEnd[1]);
                    if (dx1 <= MAX_JUMP && dy1 <= MAX_JUMP && dx1 + dy1 < bestDist) {
                        bestDist = dx1 + dy1; bestIndex = i; reverseSeg = false;
                    }

                    const pSegEnd = seg.points[seg.points.length - 1];
                    const dx2 = Math.abs(pSegEnd[0] - pEnd[0]), dy2 = Math.abs(pSegEnd[1] - pEnd[1]);
                    if (dx2 <= MAX_JUMP && dy2 <= MAX_JUMP && dx2 + dy2 < bestDist) {
                        bestDist = dx2 + dy2; bestIndex = i; reverseSeg = true;
                    }
                }

                if (bestIndex !== -1) {
                    const nextSeg = remaining[bestIndex];
                    const ptsToAdd = reverseSeg ? [...nextSeg.points].reverse() : nextSeg.points;
                    if (ptsToAdd.length > 0) {
                        const p1 = currentChain[currentChain.length - 1], p2 = ptsToAdd[0];
                        if (p1[0] === p2[0] && p1[1] === p2[1]) ptsToAdd.shift();
                    }
                    currentChain.push(...ptsToAdd);
                    remaining.splice(bestIndex, 1);
                    added = true;
                }
            }

            if (currentChain.length >= 2) {
                for (let i = 0; i < currentChain.length; i += 200) {
                    const slice = currentChain.slice(i, Math.min(i + 200, currentChain.length));
                    if (slice.length >= 2) messages.push(buildDrawMsg(slice, curHex, thick));
                }
            }
        }
        return messages;
    }

    function imageToDrawMessages(imageData, width, height) {
        applyPosterize(imageData.data, 4); // Quantize to 64 colors to prevent micro-regions
        const edgeMap = buildEdgeMap(imageData.data, width, height);
        const fillMsgs = regionFillPass(imageData.data, width, height);
        const edgeSegs = scanPass(imageData.data, width, height, edgeMap, {
            thick: EDGE_THICK, xStep: EDGE_XSTEP, yStep: EDGE_YSTEP,
            colourThresh: 10, mode: 'edge'
        });
        const edgeMsgs = greedyPack(edgeSegs, EDGE_THICK);
        return [...fillMsgs, ...edgeMsgs];
    }

    // ============================================
    //   FIND THE GAME'S CANVAS
    // ============================================
    function findGameCanvas() {
        // Drawasaurus uses a <canvas> for the drawing area
        const canvases = document.querySelectorAll('canvas');
        // Pick the largest canvas (the drawing area), not tiny UI canvases
        let best = null;
        let bestArea = 0;
        for (const c of canvases) {
            const area = c.width * c.height;
            if (area > bestArea) {
                bestArea = area;
                best = c;
            }
        }
        if (best) log(`Found game canvas: ${best.width}x${best.height}`);
        return best;
    }

    // ============================================
    //   RENDER A drawLine MESSAGE ON LOCAL CANVAS
    // ============================================
    function renderLocalLine(ctx, scaleX, scaleY, msg) {
        const payload = msg.a[1];
        const colour = payload.colour;
        const thick = payload.thick;
        const lines = payload.lines;

        // Extract actual coordinate points (skip timing markers which are [singleValue])
        const points = lines.filter(p => p.length === 2);
        if (points.length < 2) return;

        ctx.strokeStyle = colour;
        ctx.lineWidth = thick * Math.min(scaleX, scaleY);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(points[0][0] * scaleX, points[0][1] * scaleY);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i][0] * scaleX, points[i][1] * scaleY);
        }
        ctx.stroke();
    }

    // ============================================
    //   PROCESS DROPPED IMAGE
    // ============================================
    function processImage(img) {
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            canvas.width = CANVAS_W;
            canvas.height = CANVAS_H;
            const ctx = canvas.getContext('2d');

            // White background (matches game canvas)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

            // Fit image (contain)
            const scale = Math.min(CANVAS_W / img.width, CANVAS_H / img.height);
            const scaledW = img.width * scale;
            const scaledH = img.height * scale;
            const offsetX = (CANVAS_W - scaledW) / 2;
            const offsetY = (CANVAS_H - scaledH) / 2;
            ctx.drawImage(img, offsetX, offsetY, scaledW, scaledH);

            const imageData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
            const messages = imageToDrawMessages(imageData, CANVAS_W, CANVAS_H);
            log(`Generated ${messages.length} drawLine messages`);
            resolve(messages);
        });
    }

    // ============================================
    //   SEND DRAW MESSAGES + LOCAL RENDER
    // ============================================
    async function sendDraw(messages, badge) {
        if (!gameSocket || gameSocket.readyState !== OriginalWebSocket.OPEN) {
            warn('No open game socket!');
            badge.textContent = 'No socket';
            badge.className = 'error';
            return;
        }

        // Find the game canvas for local rendering
        const gameCanvas = findGameCanvas();
        let localCtx = null;
        let scaleX = 1, scaleY = 1;
        if (gameCanvas) {
            localCtx = gameCanvas.getContext('2d');
            // The game canvas may differ from our 880x750 coordinate space
            scaleX = gameCanvas.width / CANVAS_W;
            scaleY = gameCanvas.height / CANVAS_H;
            log(`Local render: scale ${scaleX.toFixed(2)}x${scaleY.toFixed(2)}`);
        } else {
            warn('Could not find game canvas -- sending only (others will still see it)');
        }

        badge.textContent = `Sending 0/${messages.length}...`;
        badge.className = 'sending';

        for (let i = 0; i < messages.length; i++) {
            if (!gameSocket || gameSocket.readyState !== OriginalWebSocket.OPEN) {
                warn(`Disconnected at ${i}/${messages.length}`);
                badge.textContent = `Disconnected at ${i}`;
                badge.className = 'error';
                return;
            }
            gameSocket.send(JSON.stringify(messages[i]));

            // Also draw on local canvas so the drawer can see it
            if (localCtx) {
                renderLocalLine(localCtx, scaleX, scaleY, messages[i]);
            }

            if ((i + 1) % 5 === 0) await new Promise(r => setTimeout(r, 4));
            if ((i + 1) % 50 === 0) {
                badge.textContent = `Sending ${i + 1}/${messages.length}...`;
            }
        }

        badge.textContent = `Sent ${messages.length} lines!`;
        badge.className = 'done';
        log(`ALL ${messages.length} messages sent!`);

        setTimeout(() => {
            badge.textContent = 'DropDraw Ready';
            badge.className = '';
        }, 5000);
    }

    // ============================================
    //   LOAD IMAGE FROM DROP EVENT
    // ============================================
    function loadImageFromDrop(e) {
        return new Promise((resolve, reject) => {
            // Priority 1: Dragged image from another tab / Google Images (URL in html or text)
            const html = e.dataTransfer.getData('text/html');
            const text = e.dataTransfer.getData('text/plain');

            // Extract image URL from dragged HTML (e.g. <img src="...">)
            let imgUrl = null;
            if (html) {
                const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
                if (match) imgUrl = match[1];
            }
            // Fallback: plain text is a URL
            if (!imgUrl && text && /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|bmp|svg)/i.test(text)) {
                imgUrl = text;
            }
            // Fallback: any URL in plain text
            if (!imgUrl && text && /^https?:\/\//i.test(text)) {
                imgUrl = text;
            }

            // Priority 2: Dropped file from Explorer
            const files = e.dataTransfer.files;

            if (imgUrl) {
                log('Loading from URL:', imgUrl);
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => resolve(img);
                img.onerror = () => {
                    // Some URLs block crossOrigin, try without (will taint canvas, but getImageData may still work on same-origin)
                    warn('CORS failed, retrying without crossOrigin...');
                    const img2 = new Image();
                    img2.onload = () => resolve(img2);
                    img2.onerror = () => reject(new Error('Failed to load image URL'));
                    img2.src = imgUrl;
                };
                img.src = imgUrl;
            } else if (files && files.length > 0 && files[0].type.startsWith('image/')) {
                log('Loading from dropped file:', files[0].name);
                const reader = new FileReader();
                reader.onload = (evt) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = () => reject(new Error('Failed to decode dropped file'));
                    img.src = evt.target.result;
                };
                reader.readAsDataURL(files[0]);
            } else {
                reject(new Error('No image found in drop data'));
            }
        });
    }

    // ============================================
    //   INIT
    // ============================================
    function init() {
        const { overlay, badge } = injectUI();
        let dragCounter = 0;

        // Show overlay on drag enter
        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            overlay.classList.add('active');
        });

        document.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                overlay.classList.remove('active');
            }
        });

        document.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        // Handle drop
        document.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter = 0;
            overlay.classList.remove('active');

            if (!gameSocket || gameSocket.readyState !== OriginalWebSocket.OPEN) {
                badge.textContent = 'Not connected to game';
                badge.className = 'error';
                setTimeout(() => { badge.textContent = 'DropDraw Ready'; badge.className = ''; }, 3000);
                return;
            }

            try {
                badge.textContent = 'Loading image...';
                badge.className = 'sending';

                const img = await loadImageFromDrop(e);
                log(`Image loaded: ${img.width}x${img.height}`);

                badge.textContent = 'Processing...';
                const messages = await processImage(img);

                if (messages.length === 0) {
                    badge.textContent = 'No drawable pixels';
                    badge.className = 'error';
                    setTimeout(() => { badge.textContent = 'DropDraw Ready'; badge.className = ''; }, 3000);
                    return;
                }

                await sendDraw(messages, badge);
            } catch (err) {
                warn('Error:', err.message);
                badge.textContent = `Error: ${err.message}`;
                badge.className = 'error';
                setTimeout(() => { badge.textContent = 'DropDraw Ready'; badge.className = ''; }, 4000);
            }
        });

        log('DropDraw initialized! Drag an image onto the page to draw.');
    }

    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
