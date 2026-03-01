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
    //   CONFIGURATION (same as draw_image.js)
    // ============================================
    const LINE_THICK = 5;
    const CANVAS_W = 880;
    const CANVAS_H = 750;
    const COLOUR_THRESHOLD = 30;
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
    //   IMAGE PROCESSING (Canvas API port of draw_image.js)
    // ============================================
    function rgbToHex(r, g, b) {
        return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    }

    function colourDistance(c1, c2) {
        return Math.sqrt((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2 + (c1[2] - c2[2]) ** 2);
    }

    function isWhite(r, g, b) {
        return r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD;
    }

    function buildDrawMsg(points, colour) {
        const TIMING_VALUES = [22, 28, 35, 43];
        const lines = [];
        for (let i = 0; i < points.length; i++) {
            lines.push(points[i]);
            if ((i + 1) % 3 === 0 && i < points.length - 1) {
                lines.push([TIMING_VALUES[Math.floor(Math.random() * TIMING_VALUES.length)]]);
            }
        }
        return {
            a: ["drawLine", {
                lines,
                colour: rgbToHex(colour[0], colour[1], colour[2]),
                thick: LINE_THICK
            }]
        };
    }

    function imageToDrawMessages(imageData, width, height) {
        const messages = [];
        const data = imageData.data; // Uint8ClampedArray [r,g,b,a, r,g,b,a, ...]

        for (let y = 0; y < height; y += LINE_THICK) {
            let segColour = null;
            let segPoints = [];

            for (let x = 0; x < width; x += 2) {
                const idx = (y * width + x) * 4;
                const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];

                // Skip transparent or white
                if (a < 128 || (SKIP_WHITE && isWhite(r, g, b))) {
                    if (segPoints.length >= 2) {
                        messages.push(buildDrawMsg(segPoints, segColour));
                    }
                    segColour = null;
                    segPoints = [];
                    continue;
                }

                const px = [r, g, b];

                if (segColour === null) {
                    segColour = px;
                    segPoints = [[x, y]];
                } else if (colourDistance(px, segColour) <= COLOUR_THRESHOLD) {
                    segPoints.push([x, y]);
                } else {
                    if (segPoints.length >= 2) {
                        messages.push(buildDrawMsg(segPoints, segColour));
                    }
                    segColour = px;
                    segPoints = [[x, y]];
                }
            }

            if (segPoints.length >= 2) {
                messages.push(buildDrawMsg(segPoints, segColour));
            }
        }

        return messages;
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
