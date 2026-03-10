// ==UserScript==
// @name         Drawasaurus DropDraw (DaVinci Port)
// @namespace    drawasaurus-dropdraw
// @version      2.0
// @description  Drag & drop any image onto Drawasaurus to auto-draw it during your turn using DaVinci algorithm
// @match        https://www.drawasaurus.org/*
// @match        https://drawasaurus.org/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ============================================
    //   CONFIGURATION
    // ============================================
    const CANVAS_W = 850;
    const CANVAS_H = 750;

    const FILL_THICK = 9;
    const MIN_REGION_PIXELS = 20;

    const EDGE_THICK = 4;
    const EDGE_YSTEP = 4;
    const EDGE_XSTEP = 2;
    const EDGE_RADIUS = 3;

    const SKIP_WHITE = true;
    const WHITE_THRESHOLD = 240;

    const COORDS_PER_MSG = 200;
    const COLOR_MERGE_DIST = 45;
    const TIMING_VALUES = [22, 28, 35, 43];

    const LOG_PREFIX = '[DropDraw]';
    const log = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);

    let gameSocket = null;

    // ============================================
    //   WEBSOCKET INTERCEPT
    // ============================================
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function (...args) {
        const ws = new OriginalWebSocket(...args);
        if (typeof args[0] === 'string' && args[0].includes('/room')) {
            gameSocket = ws;
            log('Game WebSocket captured:', args[0]);
            ws.addEventListener('close', () => {
                if (gameSocket === ws) gameSocket = null;
            });
        }
        return ws;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    Object.assign(window.WebSocket, OriginalWebSocket);

    // ============================================
    //   UI OVERLAY
    // ============================================
    function injectUI() {
        const overlay = document.createElement('div');
        overlay.id = 'dropdraw-overlay';
        overlay.innerHTML = `
            <div id="dropdraw-inner">
                <div id="dropdraw-icon">🖼️</div>
                <div id="dropdraw-text">Drop image to DaVinci draw</div>
            </div>
        `;
        document.body.appendChild(overlay);

        const badge = document.createElement('div');
        badge.id = 'dropdraw-badge';
        badge.textContent = 'DropDraw (DaVinci) Ready';
        document.body.appendChild(badge);

        const style = document.createElement('style');
        style.textContent = `
            #dropdraw-overlay {
                display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7);
                z-index: 999999; justify-content: center; align-items: center; pointer-events: none;
            }
            #dropdraw-overlay.active { display: flex; }
            #dropdraw-inner {
                text-align: center; color: #fff; padding: 40px 60px;
                border: 4px dashed #fff; border-radius: 20px; background: rgba(0,0,0,0.5);
            }
            #dropdraw-icon { font-size: 72px; margin-bottom: 15px; }
            #dropdraw-text { font-size: 26px; font-weight: bold; font-family: sans-serif; }
            #dropdraw-badge {
                position: fixed; bottom: 20px; right: 20px; background: #222; color: #fff;
                font-family: sans-serif; font-size: 14px; font-weight: bold;
                padding: 10px 15px; border-radius: 8px; z-index: 999998;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5); transition: background 0.3s;
            }
        `;
        document.head.appendChild(style);
        return { overlay, badge };
    }

    // ============================================
    //   DAVINCI ALGORITHM
    // ============================================
    function getPixel(data, w, x, y) {
        const i = (y * w + x) * 4;
        return { r: data[i], g: data[i+1], b: data[i+2], a: data[i+3] };
    }
    function rgbToHex(r, g, b) {
        return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    }
    function colourDist(a, b) {
        return Math.sqrt((a.r - b.r)**2 + (a.g - b.g)**2 + (a.b - b.b)**2);
    }
    function hexDist(h1, h2) {
        const r1 = parseInt(h1.slice(1,3),16), g1 = parseInt(h1.slice(3,5),16), b1 = parseInt(h1.slice(5,7),16);
        const r2 = parseInt(h2.slice(1,3),16), g2 = parseInt(h2.slice(3,5),16), b2 = parseInt(h2.slice(5,7),16);
        return Math.sqrt((r1 - r2)**2 + (g1 - g2)**2 + (b1 - b2)**2);
    }
    function isWhite(c) {
        return c.a < 128 || (c.r >= WHITE_THRESHOLD && c.g >= WHITE_THRESHOLD && c.b >= WHITE_THRESHOLD);
    }

    function buildDrawMsg(points, hexColor, thick) {
        const lines = [];
        for (let i = 0; i < points.length; i++) {
            lines.push(points[i]);
            if ((i + 1) % 3 === 0 && i < points.length - 1) {
                lines.push([TIMING_VALUES[(Math.random() * TIMING_VALUES.length) | 0]]);
            }
        }
        return { a: ["drawLine", { lines, colour: hexColor, thick }] };
    }

    // Posterize replaces sharp's quantization for browser
    function quantizeData(imageData) {
        const d = imageData.data;
        const levels = 8; 
        const step = 255 / (levels - 1);
        for (let i = 0; i < d.length; i += 4) {
            d[i]   = Math.round(d[i]   / step) * step;
            d[i+1] = Math.round(d[i+1] / step) * step;
            d[i+2] = Math.round(d[i+2] / step) * step;
            d[i+3] = 255;
        }
    }

    function buildEdgeMap(data, w, h) {
        const bounds = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const c = getPixel(data, w, x, y);
                if (isWhite(c)) continue;
                const up = getPixel(data, w, x, y-1), dn = getPixel(data, w, x, y+1);
                const lt = getPixel(data, w, x-1, y), rt = getPixel(data, w, x+1, y);
                if (colourDist(c, up)>0 || colourDist(c, dn)>0 || colourDist(c, lt)>0 || colourDist(c, rt)>0) {
                    bounds[y * w + x] = 1;
                }
            }
        }
        const nearEdge = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (bounds[y * w + x]) {
                    for (let dy = -EDGE_RADIUS; dy <= EDGE_RADIUS; dy++) {
                        for (let dx = -EDGE_RADIUS; dx <= EDGE_RADIUS; dx++) {
                            const ny = y + dy, nx = x + dx;
                            if (ny >= 0 && ny < h && nx >= 0 && nx < w) nearEdge[ny * w + nx] = 1;
                        }
                    }
                }
            }
        }
        return nearEdge;
    }

    async function floodFillRegions(data, w, h) {
        const visited = new Uint8Array(w * h);
        const regions = [];
        for (let y = 0; y < h; y++) {
            if (y % 20 === 0) await new Promise(r => setTimeout(r, 0)); // Yield to UI thread
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                if (visited[idx]) continue;
                const p = getPixel(data, w, x, y);
                if (SKIP_WHITE && isWhite(p)) { visited[idx] = 1; continue; }

                const hex = rgbToHex(p.r, p.g, p.b);
                const pixels = [];
                let minX = x, maxX = x, minY = y, maxY = y;
                const q = [[x, y]];
                let head = 0;
                visited[idx] = 1;

                while (head < q.length) {
                    const [cx, cy] = q[head++];
                    pixels.push([cx, cy]);
                    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;

                    const nbrs = [[cx-1, cy], [cx+1, cy], [cx, cy-1], [cx, cy+1]];
                    for (const [nx, ny] of nbrs) {
                        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                        const nidx = ny * w + nx;
                        if (!visited[nidx]) {
                            const np = getPixel(data, w, nx, ny);
                            if (np.r === p.r && np.g === p.g && np.b === p.b) {
                                visited[nidx] = 1;
                                q.push([nx, ny]);
                            }
                        }
                    }
                }
                if (pixels.length >= MIN_REGION_PIXELS) {
                    regions.push({ hex, pixels, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } });
                }
            }
        }
        return regions;
    }

    function meanderRegion(region, thick) {
        const { bbox, pixels } = region;
        const step = Math.max(thick - 2, 1);
        const MAX_GAP = thick * 1.5;
        const pSet = new Set(pixels.map(([px, py]) => py * 65536 + px));
        const polylines = [];
        let cur = [];

        const flush = () => { if (cur.length >= 2) polylines.push(cur); cur = []; };
        const tooBig = (pt) => {
            if (!cur.length) return false;
            const last = cur[cur.length - 1];
            return (Math.abs(pt[0] - last[0]) > MAX_GAP || Math.abs(pt[1] - last[1]) > MAX_GAP);
        };

        if (bbox.w >= bbox.h) {
            let row = 0;
            for (let y = bbox.y; y <= bbox.y + bbox.h - 1; y += step) {
                const right = (row % 2 === 0);
                const runs = [];
                let st = -1;
                for (let x = bbox.x; x <= bbox.x + bbox.w - 1; x++) {
                    const inR = pSet.has(y * 65536 + x);
                    if (inR && st === -1) st = x;
                    else if (!inR && st !== -1) { runs.push([st, x - 1]); st = -1; }
                }
                if (st !== -1) runs.push([st, bbox.x + bbox.w - 1]);
                if (!runs.length) { row++; continue; }
                if (!right) runs.reverse();
                for (const [rs, re] of runs) {
                    const p1 = right ? [rs, y] : [re, y];
                    const p2 = (re > rs) ? (right ? [re, y] : [rs, y]) : null;
                    if (tooBig(p1)) flush();
                    cur.push(p1);
                    if (p2) cur.push(p2);
                }
                row++;
            }
        } else {
            let col = 0;
            for (let x = bbox.x; x <= bbox.x + bbox.w - 1; x += step) {
                const down = (col % 2 === 0);
                const runs = [];
                let st = -1;
                for (let y = bbox.y; y <= bbox.y + bbox.h - 1; y++) {
                    const inR = pSet.has(y * 65536 + x);
                    if (inR && st === -1) st = y;
                    else if (!inR && st !== -1) { runs.push([st, y - 1]); st = -1; }
                }
                if (st !== -1) runs.push([st, bbox.y + bbox.h - 1]);
                if (!runs.length) { col++; continue; }
                if (!down) runs.reverse();
                for (const [rs, re] of runs) {
                    const p1 = down ? [x, rs] : [x, re];
                    const p2 = (re > rs) ? (down ? [x, re] : [x, rs]) : null;
                    if (tooBig(p1)) flush();
                    cur.push(p1);
                    if (p2) cur.push(p2);
                }
                col++;
            }
        }
        flush();
        return polylines;
    }

    async function scanPass(data, w, h, edgeMap) {
        const segments = [];
        let row = 0;
        for (let y = 0; y < h; y += EDGE_YSTEP) {
            if (row % 20 === 0) await new Promise(r => setTimeout(r, 0));
            let sc = null, ss = null, se = null;
            const right = (row % 2 === 0);
            const x0 = right ? 0 : w - 1, x1 = right ? w : -1, xd = right ? EDGE_XSTEP : -EDGE_XSTEP;

            for (let x = x0; x !== x1 && (right ? x < w : x >= 0); x += xd) {
                const p = getPixel(data, w, x, y);
                const isE = edgeMap[y * w + x] === 1;

                let skip = false;
                if (SKIP_WHITE && isWhite(p)) skip = true;
                else if (!isE) skip = true; // Mode 'edge' only

                if (skip) {
                    if (ss && ss[0] !== se[0]) segments.push({ hex: rgbToHex(sc.r, sc.g, sc.b), points: [ss, se] });
                    sc = ss = se = null;
                    continue;
                }

                if (!sc) {
                    sc = p; ss = se = [x, y];
                } else if (colourDist(p, sc) <= 10) {
                    se = [x, y];
                } else {
                    if (ss && ss[0] !== se[0]) segments.push({ hex: rgbToHex(sc.r, sc.g, sc.b), points: [ss, se] });
                    sc = p; ss = se = [x, y];
                }
            }
            if (ss && ss[0] !== se[0]) segments.push({ hex: rgbToHex(sc.r, sc.g, sc.b), points: [ss, se] });
            row++;
        }
        return segments;
    }

    async function greedyPack(segments, thick) {
        const MAX_JUMP = thick * 5;
        const msgs = [];
        const rem = [...segments];

        let loopCount = 0;
        while (rem.length > 0) {
            const first = rem.shift();
            const chain = [...first.points];
            let added = true;

            while (added) {
                if (++loopCount % 50 === 0) await new Promise(r => setTimeout(r, 0));
                added = false;
                let bIdx = -1, bDist = MAX_JUMP * 2 + 1, rev = false;
                const endP = chain[chain.length - 1];

                for (let i = 0; i < rem.length; i++) {
                    const s = rem[i];
                    if (s.hex !== first.hex && hexDist(s.hex, first.hex) > COLOR_MERGE_DIST) continue;

                    const d1 = Math.abs(s.points[0][0] - endP[0]) + Math.abs(s.points[0][1] - endP[1]);
                    if (d1 <= MAX_JUMP * 2 && d1 < bDist) { bDist = d1; bIdx = i; rev = false; }

                    const lx = s.points[s.points.length-1][0], ly = s.points[s.points.length-1][1];
                    const d2 = Math.abs(lx - endP[0]) + Math.abs(ly - endP[1]);
                    if (d2 <= MAX_JUMP * 2 && d2 < bDist) { bDist = d2; bIdx = i; rev = true; }
                }

                if (bIdx !== -1) {
                    const toAdd = rev ? [...rem[bIdx].points].reverse() : rem[bIdx].points;
                    if (toAdd.length > 0 && toAdd[0][0] === endP[0] && toAdd[0][1] === endP[1]) toAdd.shift();
                    chain.push(...toAdd);
                    rem.splice(bIdx, 1);
                    added = true;
                }
            }

            if (chain.length >= 2) {
                for (let i = 0; i < chain.length; i += COORDS_PER_MSG) {
                    const sl = chain.slice(i, Math.min(i + COORDS_PER_MSG, chain.length));
                    if (sl.length >= 2) msgs.push(buildDrawMsg(sl, first.hex, thick));
                }
            }
        }
        return msgs;
    }

    async function processImageToMessages(imageData, badge) {
        log('Quantizing...');
        if (badge) badge.textContent = 'Quantizing...';
        quantizeData(imageData);
        await new Promise(r => setTimeout(r, 10));

        log('Edge map...');
        if (badge) badge.textContent = 'Mapping edges...';
        const edgeMap = buildEdgeMap(imageData.data, CANVAS_W, CANVAS_H);
        await new Promise(r => setTimeout(r, 10));

        log('Region fill pass...');
        if (badge) badge.textContent = 'Fill pass...';
        const fillMsgs = [];
        const regions = await floodFillRegions(imageData.data, CANVAS_W, CANVAS_H);
        regions.sort((a,b) => b.pixels.length - a.pixels.length);
        log(`[Region] Found ${regions.length} color regions (min ${MIN_REGION_PIXELS}px)`);
        
        for (const r of regions) {
            for (const pl of meanderRegion(r, FILL_THICK)) {
                for (let i = 0; i < pl.length; i += COORDS_PER_MSG) {
                    const sl = pl.slice(i, Math.min(i + COORDS_PER_MSG, pl.length));
                    if (sl.length >= 2) fillMsgs.push(buildDrawMsg(sl, r.hex, FILL_THICK));
                }
            }
        }
        log(`[Fill] ${regions.length} regions → ${fillMsgs.length} messages`);
        await new Promise(r => setTimeout(r, 10));

        log('Scan edge pass...');
        if (badge) badge.textContent = 'Edge pass...';
        const edgeSegs = await scanPass(imageData.data, CANVAS_W, CANVAS_H, edgeMap);
        const edgeMsgs = await greedyPack(edgeSegs, EDGE_THICK);
        log(`[Edge] ${edgeSegs.length} segments → ${edgeMsgs.length} messages`);

        log(`[Process] Total: ${fillMsgs.length + edgeMsgs.length} messages (fill: ${fillMsgs.length}, edge: ${edgeMsgs.length})`);
        return [...fillMsgs, ...edgeMsgs];
    }

    // ============================================
    //   DRAG & DROP LOGIC
    // ============================================
    function findGameCanvas() {
        let best = null, maxA = 0;
        for (const c of document.querySelectorAll('canvas')) {
            const a = c.width * c.height;
            if (a > maxA) { maxA = a; best = c; }
        }
        return best;
    }

    async function sendAll(msgs, badge) {
        if (!gameSocket || gameSocket.readyState !== 1) {
            badge.textContent = 'Error: Not connected to game!';
            badge.style.background = '#e74c3c';
            return;
        }

        const cvs = findGameCanvas();
        const ctx = cvs ? cvs.getContext('2d') : null;
        const sx = cvs ? cvs.width / CANVAS_W : 1, sy = cvs ? cvs.height / CANVAS_H : 1;

        badge.style.background = '#e67e22';
        for (let i = 0; i < msgs.length; i++) {
            if (gameSocket.readyState !== 1) break;
            gameSocket.send(JSON.stringify(msgs[i]));

            if (ctx) {
                const lines = msgs[i].a[1].lines.filter(l => l.length === 2);
                if (lines.length >= 2) {
                    ctx.strokeStyle = msgs[i].a[1].colour;
                    ctx.lineWidth = msgs[i].a[1].thick * Math.min(sx, sy);
                    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                    ctx.beginPath();
                    ctx.moveTo(lines[0][0]*sx, lines[0][1]*sy);
                    for (let j=1; j<lines.length; j++) ctx.lineTo(lines[j][0]*sx, lines[j][1]*sy);
                    ctx.stroke();
                }
            }

            if ((i + 1) % 3 === 0) await new Promise(r => setTimeout(r, 16));
            if ((i + 1) % 20 === 0 || i === 0) badge.textContent = `Drawing ${i+1}/${msgs.length}`;
        }
        badge.textContent = 'Drawing Complete!';
        badge.style.background = '#2ecc71';
        setTimeout(() => {
            badge.textContent = 'DropDraw (DaVinci) Ready';
            badge.style.background = '#222';
        }, 5000);
    }

    function init() {
        const { overlay, badge } = injectUI();
        let drags = 0;

        document.addEventListener('dragenter', e => { e.preventDefault(); drags++; overlay.classList.add('active'); });
        document.addEventListener('dragleave', e => { e.preventDefault(); drags--; if (drags <= 0) { drags = 0; overlay.classList.remove('active'); }});
        document.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });

        document.addEventListener('drop', async e => {
            e.preventDefault(); drags = 0; overlay.classList.remove('active');

            if (!gameSocket || gameSocket.readyState !== 1) {
                badge.textContent = 'Not in a game!';
                badge.style.background = '#e74c3c';
                setTimeout(() => { badge.textContent = 'DropDraw Ready'; badge.style.background = '#222'; }, 3000);
                return;
            }

            badge.textContent = 'Loading Image...';
            badge.style.background = '#f39c12';

            const dtf = e.dataTransfer;
            const html = dtf.getData('text/html'), text = dtf.getData('text/plain');
            let url = null;
            if (html && html.match(/<img[^>]+src=["']([^"']+)["']/i)) url = html.match(/<img[^>]+src=["']([^"']+)["']/i)[1];
            else if (text && /^https?:\/\//i.test(text)) url = text;

            const files = dtf.files;

            const img = new Image();
            img.crossOrigin = 'anonymous';

            const loadPromise = new Promise((res, rej) => {
                img.onload = () => res();
                img.onerror = () => {
                    if (url && img.crossOrigin) {
                        warn('CORS failed, retry without crossOrigin...');
                        img.crossOrigin = '';
                        img.src = url;
                    } else rej(new Error('Image failed to load'));
                }
            });

            if (url) {
                img.src = url;
            } else if (files && files.length > 0 && files[0].type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = ev => img.src = ev.target.result;
                reader.readAsDataURL(files[0]);
            } else {
                badge.textContent = 'Invalid Drop';
                badge.style.background = '#e74c3c';
                return;
            }

            try {
                await loadPromise;
                const canvas = document.createElement('canvas');
                canvas.width = CANVAS_W; canvas.height = CANVAS_H;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

                const scale = Math.min(CANVAS_W / img.width, CANVAS_H / img.height);
                const sw = img.width * scale, sh = img.height * scale;
                ctx.imageSmoothingEnabled = false; // Prevent blurring during resize
                ctx.drawImage(img, (CANVAS_W - sw)/2, (CANVAS_H - sh)/2, sw, sh);

                const imageData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
                const msgs = await processImageToMessages(imageData, badge);

                if (!msgs.length) throw new Error("No drawable pixels");
                await sendAll(msgs, badge);

            } catch (err) {
                badge.textContent = 'Error: ' + err.message;
                badge.style.background = '#e74c3c';
                setTimeout(() => { badge.textContent = 'DropDraw Ready'; badge.style.background = '#222'; }, 4000);
            }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
