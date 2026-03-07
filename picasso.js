/**
 * Picasso - A sophisticated Drawasaurus bot that searches for images,
 * processes them, and draws them on the game canvas via WebSockets.
 * 
 * Pipeline Overview:
 * 1. Word Picked: When it's the bot's turn, it chooses a word.
 * 2. Search: Searches Google Images for a clipart/transparent version of the word.
 * 3. Evaluate: Scores candidates based on darkness, density, entropy, and aspect ratio.
 * 4. Process: Performs edge density analysis to generate dynamic drawing parameters.
 * 5. Extract Paths: Identifies the background (BFS), finds dark lines, and traces them.
 * 6. Simplify: Uses the Ramer-Douglas-Peucker (RDP) algorithm to optimize path data.
 * 7. Draw: Sends optimized 'drawLine' messages to the game server.
 */

// ============================================
//   CONFIGURATION
// ============================================

/** @type {string} Target room name on Drawasaurus. */
const ROOM_NAME = 'The Cool Room2';

/** @type {string} Display name for the bot. */
const USERNAME = 'Picasso';

/** @type {string} Specific version hash used by the Drawasaurus client. */
const DRAWASAURUS_VERSION = '52a35d2755939386a8de91b399fc0ff770deb697';

/** @type {number} Hard limit on the number of paths to draw for performance. */
const MAX_PATHS = 1500;

/** @type {number} Maximum points allowed in a single WebSocket 'drawLine' message. */
const MAX_POINTS_PER_MSG = 30;

/** @type {number} Maximum number of automatic reconnection attempts. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** @type {number} Bias between drawing long paths (1.0) and dark paths (0.0). */
const PATH_LENGTH_WEIGHT = 0.75;

const WebSocket = require('ws');
const sharp = require('sharp');
const axios = require('axios');
const { GOOGLE_IMG_SCRAP } = require('google-img-scrap');
const readline = require('readline');

// ANSI Colors
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BRIGHT = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

/**
 * Logs a general event in dimmed color.
 * @param {string} msg 
 */
function logEvent(msg) {
    console.log(`${DIM}${msg}${RESET}`);
}

/**
 * Logs drawing-related progress in green.
 * @param {string} msg 
 */
function logDraw(msg) {
    console.log(`${GREEN}${msg}${RESET}`);
}

/**
 * Logs user chat/input in bright yellow.
 * @param {string} msg 
 */
function logUser(msg) {
    console.log(`${BRIGHT}${YELLOW}${msg}${RESET}`);
}

/**
 * Linear interpolation between two values.
 * @param {number} a Start value
 * @param {number} b End value
 * @param {number} t Interpolation factor (0 to 1)
 * @returns {number}
 */
function lerp(a, b, t) {
    return a + (b - a) * t;
}

/**
 * Generates drawing parameters based on the image's edge density.
 * Simple images get bolder, smoother lines; complex images get finer detail.
 * @param {number} density Edge density (0..1)
 * @returns {Object} params Configuration for drawing (thickness, dimensions, thresholds)
 */
function generateDynamicParams(density) {
    // Expected density range for normalization (approx 0.01 to 0.12)
    const DENSITY_MIN = 0.02;
    const DENSITY_MAX = 0.15;
    
    // Clamp and normalize density to 0..1 (0 = simple/clean, 1 = complex/busy)
    let t = (density - DENSITY_MIN) / (DENSITY_MAX - DENSITY_MIN);
    t = Math.max(0, Math.min(1, t));

    // Beauty-first params: Lower density images get thicker, smoother lines for a "sketchbook" look.
    // Complex images get thinner, more precise lines.
    const params = {
        thick: Math.round(lerp(3, 1, t)),      // Simpler: 3 (bolder), Complex: 2 (detailed)
        w: Math.round(lerp(500, 750, t)),      // Simpler: 600, Complex: 850
        h: Math.round(lerp(550, 700, t)),      // Simpler: 550, Complex: 800
        threshold: lerp(35, 10, t),           // Tighter color matching (Simpler: 35, Complex: 15)
        simplify: lerp(1.5, 0.3, t),         // Higher fidelity at both ends
        minLen: Math.round(lerp(4, 2, t))      // Filter more noise on simple images
    };

    logDraw(`[Complexity] Dynamic Params (t=${t.toFixed(2)}): ${JSON.stringify(params)}`);
    return params;
}

/**
 * Analyzes an image's complexity by calculating its edge density.
 * Uses a Laplacian-style convolution kernel for edge detection.
 * @param {Buffer} imageBuffer 
 * @returns {Promise<number>} Edge density (0..1)
 */
async function analyzeComplexity(imageBuffer) {
    try {
        const { data, info } = await sharp(imageBuffer)
            .greyscale()
            .convolve({
                width: 3,
                height: 3,
                kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1]
            })
            .raw()
            .toBuffer({ resolveWithObject: true });

        let edgeSum = 0;
        for (let i = 0; i < data.length; i++) {
            edgeSum += data[i];
        }
        const density = edgeSum / data.length / 255;
        logDraw(`[Complexity] Edge density: ${(density * 100).toFixed(2)}%`);
        return density;
    } catch (err) {
        logDraw(`[Complexity] Analysis failed: ${err.message}`);
        return 0.05; // Default middle-ground
    }
}

// Game canvas dimensions
const GAME_W = 880;
const GAME_H = 750;
const SKIP_WHITE = true;
const WHITE_THRESHOLD = 245;

// ============================================
//   Ramer-Douglas-Peucker (RDP) Algorithm
// ============================================

/**
 * Calculates the squared perpendicular distance from a point to a line segment.
 * @param {number[]} p The point [x, y]
 * @param {number[]} p1 Start of segment [x, y]
 * @param {number[]} p2 End of segment [x, y]
 * @returns {number}
 */
function getSqSegDist(p, p1, p2) {
    let x = p1[0],
        y = p1[1],
        dx = p2[0] - x,
        dy = p2[1] - y;
    if (dx !== 0 || dy !== 0) {
        let t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
        if (t > 1) {
            x = p2[0];
            y = p2[1];
        } else if (t > 0) {
            x += dx * t;
            y += dy * t;
        }
    }
    dx = p[0] - x;
    dy = p[1] - y;
    return dx * dx + dy * dy;
}

/**
 * Recursive step for the RDP algorithm.
 */
function simplifyStep(points, first, last, sqTolerance, simplified) {
    let maxSqDist = sqTolerance,
        index;
    for (let i = first + 1; i < last; i++) {
        let sqDist = getSqSegDist(points[i], points[first], points[last]);
        if (sqDist > maxSqDist) {
            index = i;
            maxSqDist = sqDist;
        }
    }
    if (maxSqDist > sqTolerance) {
        if (index - first > 1) simplifyStep(points, first, index, sqTolerance, simplified);
        simplified.push(points[index]);
        if (last - index > 1) simplifyStep(points, index, last, sqTolerance, simplified);
    }
}

/**
 * Simplifies a polyline by removing redundant points while preserving its shape.
 * Features an adaptive tolerance mechanism that tightens for curvy paths.
 * @param {number[][]} points Array of [x, y] coordinates
 * @param {number} tolerance Maximum allowed deviation
 * @returns {number[][]} Simplified array of points
 */
function simplifyPath(points, tolerance) {
    if (points.length <= 2) return points;
    
    // Adaptive RDP: if path is long and curvy, use tighter tolerance
    let adaptiveTolerance = tolerance;
    if (points.length > 10) {
        const start = points[0];
        const end = points[points.length - 1];
        const directDist = Math.sqrt((start[0]-end[0])**2 + (start[1]-end[1])**2);
        const actualDist = points.length; // rough estimate
        if (actualDist > directDist * 1.5) {
            adaptiveTolerance *= 0.7; // Preserving curves
        }
    }

    let sqTolerance = adaptiveTolerance !== undefined ? adaptiveTolerance * adaptiveTolerance : 1;
    let simplified = [points[0]];
    simplifyStep(points, 0, points.length - 1, sqTolerance, simplified);
    simplified.push(points[points.length - 1]);
    return simplified;
}

// ============================================
//   SEARCH & DOWNLOAD
// ============================================

/**
 * Scores an image candidate based on its suitability for drawing.
 * High scores are given to images with high darkness (ink), moderate density,
 * high entropy (detail), and an aspect ratio that fits the game canvas.
 * @param {Buffer} buffer Image data
 * @param {number} density Previously calculated edge density
 * @returns {Promise<Object>} Statistics and the final beauty score
 */
async function evaluateBeauty(buffer, density) {
    try {
        const stats = await sharp(buffer).stats();
        const entropy = stats.entropy || 0;
        
        const metadata = await sharp(buffer).metadata();
        const aspectRatio = metadata.width / metadata.height;
        const targetRatio = GAME_W / GAME_H;
        const ratioFit = 1 - Math.min(1, Math.abs(aspectRatio - targetRatio) / targetRatio);

        // DARKNESS: Prefer images with more ink/darkness
        const avgR = stats.channels[0].mean;
        const avgG = stats.channels[1].mean;
        const avgB = stats.channels[2].mean;
        const darkness = 1 - ((avgR + avgG + avgB) / (3 * 255));

        // Density: Prefer mid-range (0.025 - 0.065) for cleaner sketches
        let densityScore = 0;
        if (density >= 0.025 && density <= 0.065) densityScore = 1.0;
        else if (density < 0.025) densityScore = density / 0.025;
        else densityScore = Math.max(0, 1 - (density - 0.065) / 0.15);

        // Color diversity: prefer images with some color but not too much (limit noise)
        const channels = stats.channels;
        const colorDiversity = channels.reduce((acc, c) => acc + c.stdev, 0) / (channels.length * 50);
        const diversityScore = Math.min(1.0, colorDiversity);

        // Score prioritizing darkness significantly
        const score = (darkness * 0.5) + (densityScore * 0.2) + (entropy / 10 * 0.15) + (ratioFit * 0.1) + (diversityScore * 0.05);
        return { score, darkness, density, entropy };
    } catch (err) {
        return { score: 0, darkness: 0, density: 0, entropy: 0 };
    }
}

/**
 * Searches Google Images for the given query and selects the best candidate.
 * It downloads and evaluates multiple images before picking the "winner".
 * @param {string} query The word to search for
 * @returns {Promise<Object[]>} Array of 'drawLine' messages for the best image
 */
async function searchAndProcessImage(query) {
    const optimizedQuery = `${query} clipart transparent background`;
    logDraw(`[Search] Searching for: "${optimizedQuery}"...`);
    try {
        const results = await GOOGLE_IMG_SCRAP({
            search: optimizedQuery,
            limit: 12,
            safeSearch: true,
        });

        if (!results.result || results.result.length === 0) {
            throw new Error('No images found for that word.');
        }

        const candidates = [];
        const seenUrls = new Set();

        for (let i = 0; i < results.result.length && candidates.length < 3; i++) {
            const imageUrl = results.result[i].url;

            if (seenUrls.has(imageUrl)) continue;
            seenUrls.add(imageUrl);

            try {
                const response = await axios.get(imageUrl, {
                    responseType: 'arraybuffer',
                    timeout: 4000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                });

                const buffer = Buffer.from(response.data);
                const density = await analyzeComplexity(buffer);
                const evaluation = await evaluateBeauty(buffer, density);
                
                candidates.push({ 
                    buffer, 
                    density, 
                    score: evaluation.score, 
                    darkness: evaluation.darkness,
                    url: imageUrl 
                });
            } catch (err) {
                continue;
            }
        }

        if (candidates.length === 0) {
            throw new Error('None of the search results could be processed.');
        }

        // Display results summary
        logDraw(`\n[Search Results for "${query}"]:`);
        candidates.sort((a, b) => b.score - a.score).forEach((c, idx) => {
            logDraw(`${idx === 0 ? '  =>' : '    '} Score: ${c.score.toFixed(3)} | Dark: ${c.darkness.toFixed(3)} | URL: ${c.url}`);
        });
        logDraw('');

        const winner = candidates[0];
        const params = generateDynamicParams(winner.density);
        const messages = await imageToDrawMessages(winner.buffer, params);
        return messages;
    } catch (error) {
        console.error(`[Search/Process] Error: ${error.message}`);
        throw error;
    }
}

// ============================================
//   IMAGE PROCESSING & PATH FINDING
// ============================================

/**
 * Resizes and pre-processes an image for drawing.
 * Applies sharpening, saturation boost, and a median filter to reduce noise.
 * @param {Buffer} imageInput 
 * @param {Object} params Drawing parameters (w, h)
 * @returns {Promise<Object>} Image pixel data and metadata
 */
async function loadImage(imageInput, params) {
    logDraw(`[Image] Processing image...`);
    
    const image = sharp(imageInput)
        .resize(params.w, params.h, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .sharpen()
        .modulate({ saturation: 1.2 })
        .median(3);

    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

    logDraw(`[Image] Loaded: ${info.width}x${info.height} (${info.channels} channels)`);
    return { pixels: data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Gets the RGBA values for a specific pixel coordinate.
 * @returns {Object|null} {r, g, b, a} or null if out of bounds
 */
function getPixel(pixels, width, channels, x, y, canvasW, canvasH) {
    if (x < 0 || x >= canvasW || y < 0 || y >= canvasH) return null;
    const idx = (y * width + x) * channels;
    return {
        r: pixels[idx],
        g: pixels[idx + 1],
        b: pixels[idx + 2],
        a: channels === 4 ? pixels[idx + 3] : 255
    };
}

/**
 * Converts RGB components to a hex color string.
 * @returns {string} e.g. "#ff0000"
 */
function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Calculates the Euclidean distance between two colors in RGB space.
 */
function colourDistance(c1, c2) {
    if (!c1 || !c2) return 1000;
    return Math.sqrt((c1.r - c2.r) ** 2 + (c1.g - c2.g) ** 2 + (c1.b - c2.b) ** 2);
}

/**
 * Determines if a pixel is likely part of the "background" (white or light gray).
 * @param {Object} c {r, g, b}
 * @returns {boolean}
 */
function isBackgroundCandidate(c) {
    if (c.r >= WHITE_THRESHOLD && c.g >= WHITE_THRESHOLD && c.b >= WHITE_THRESHOLD) return true;
    const isGray = Math.abs(c.r - c.g) < 15 && Math.abs(c.g - c.b) < 15 && Math.abs(c.r - c.b) < 15;
    const isLight = c.r > 180 && c.g > 180 && c.b > 180;
    return isGray && isLight;
}

// ============================================
//   CONVERT IMAGE TO drawLine MESSAGES
// ============================================

/**
 * High-level orchestration for converting an image into a series of drawing messages.
 * 1. Identifies background using a BFS starting from image edges.
 * 2. Scans for candidate pixels and traces them into paths.
 * 3. Centers the drawing and sorts paths by length/darkness.
 * 4. Simplifies paths and converts them into 'drawLine' chunks.
 * @param {Buffer} imageInput 
 * @param {Object} params Drawing parameters
 * @returns {Promise<Object[]>} WebSocket messages
 */
async function imageToDrawMessages(imageInput, params) {
    const img = await loadImage(imageInput, params);
    const visited = new Uint8Array(img.width * img.height);
    const bgMap = new Uint8Array(img.width * img.height); // 1 = background
    let pixelPaths = [];

    logDraw(`[Image] Identifying background...`);

    // BFS to find all pixels connected to the edge that look like background
    const q = [];
    for (let x = 0; x < img.width; x++) { q.push([x, 0]); q.push([x, img.height - 1]); }
    for (let y = 1; y < img.height - 1; y++) { q.push([0, y]); q.push([img.width - 1, y]); }

    while (q.length > 0) {
        const [cx, cy] = q.shift();
        const idx = cy * img.width + cx;
        if (bgMap[idx]) continue;

        const pixel = getPixel(img.pixels, img.width, img.channels, cx, cy, params.w, params.h);
        if (pixel && (pixel.a < 64 || isBackgroundCandidate(pixel))) {
            bgMap[idx] = 1;
            const neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
            for (const [nx, ny] of neighbors) {
                if (nx >= 0 && nx < img.width && ny >= 0 && ny < img.height && !bgMap[ny * img.width + nx]) {
                    q.push([nx, ny]);
                }
            }
        }
    }

    logDraw(`[Image] Extracting paths...`);

    // Prioritize drawing dark colors/lines first (better for "sketch" aesthetic)
    const candidates = [];
    for (let y = 0; y < img.height; y += params.thick) {
        for (let x = 0; x < img.width; x += params.thick) {
            const pixel = getPixel(img.pixels, img.width, img.channels, x, y, params.w, params.h);
            if (!pixel || pixel.a < 128) continue;
            const brightness = (pixel.r + pixel.g + pixel.b) / 3;
            candidates.push({ x, y, brightness });
        }
    }
    // Sort candidates by brightness (darkest first)
    candidates.sort((a, b) => a.brightness - b.brightness);

    // Path tracing loop
    for (const cand of candidates) {
        const { x, y } = cand;
        const idx = y * img.width + x;
        if (visited[idx] || (SKIP_WHITE && bgMap[idx])) continue;

        const pixel = getPixel(img.pixels, img.width, img.channels, x, y, params.w, params.h);
        const currentPath = { colour: pixel, points: [] };
        let curX = x, curY = y;

        while (true) {
            currentPath.points.push([curX, curY]);
            visited[curY * img.width + curX] = 1;
            let bestNeighbor = null;

            // Search in expanding squares to find the "closest" matching pixel
            let found = false;
            for (let r = 1; r <= 1; r++) { // Stay tight for beauty
                for (let dy = -r * params.thick; dy <= r * params.thick; dy += params.thick) {
                    for (let dx = -r * params.thick; dx <= r * params.thick; dx += params.thick) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = curX + dx, ny = curY + dy;
                        if (nx >= 0 && nx < img.width && ny >= 0 && ny < img.height) {
                            const nIdx = ny * img.width + nx;
                            if (!visited[nIdx] && !(SKIP_WHITE && bgMap[nIdx])) {
                                const nPixel = getPixel(img.pixels, img.width, img.channels, nx, ny, params.w, params.h);
                                if (nPixel && nPixel.a >= 128 && colourDistance(pixel, nPixel) <= params.threshold) {
                                    bestNeighbor = { x: nx, y: ny };
                                    found = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (found) break;
                }
                if (found) break;
            }

            if (bestNeighbor) { curX = bestNeighbor.x; curY = bestNeighbor.y; } else break;
            if (currentPath.points.length > 60) break; // Slightly longer paths for beauty
        }

        if (currentPath.points.length >= params.minLen) pixelPaths.push(currentPath);
    }

    logDraw(`[Image] Aligning and sorting paths...`);
    const allPaths = pixelPaths;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    // Calculate bounding box for centering
    allPaths.forEach(p => {
        p.points.forEach(pt => {
            if (pt[0] < minX) minX = pt[0];
            if (pt[0] > maxX) maxX = pt[0];
            if (pt[1] < minY) minY = pt[1];
            if (pt[1] > maxY) maxY = pt[1];
        });
    });

    const drawingCenterX = minX + ((maxX - minX) / 2);
    const drawingCenterY = minY + ((maxY - minY) / 2);
    const offsetX = Math.floor((GAME_W / 2) - drawingCenterX);
    const offsetY = Math.floor((GAME_H / 2) - drawingCenterY);

    /**
     * Centers all points and sorts paths based on a weighted score of length and darkness.
     */
    const centerAndSort = (pathGroup) => {
        pathGroup.forEach(p => {
            p.points = p.points.map(pt => [pt[0] + offsetX, pt[1] + offsetY]);
        });

        let maxLen = 0;
        pathGroup.forEach(p => { if (p.points.length > maxLen) maxLen = p.points.length; });

        const lengthWeight = PATH_LENGTH_WEIGHT;
        const darknessWeight = 1 - PATH_LENGTH_WEIGHT;

        pathGroup.sort((a, b) => {
            const getScore = (p) => {
                const darkness = 1 - ((p.colour.r + p.colour.g + p.colour.b) / (3 * 255));
                const lengthNorm = p.points.length / (maxLen || 1);
                return (darknessWeight * darkness) + (lengthWeight * lengthNorm);
            };
            return getScore(b) - getScore(a);
        });
    };

    centerAndSort(pixelPaths);

    const finalPaths = pixelPaths.slice(0, MAX_PATHS);
    const TIMING_VALUES = [22, 28, 35, 43];
    
    const messages = finalPaths.flatMap(p => buildDrawMsgs(p.points, p.colour, TIMING_VALUES, params, p.isEdge));

    logDraw(`[Image] Generated ${messages.length} drawLine messages (from ${finalPaths.length} paths)`);
    return messages;
}

/**
 * Builds 'drawLine' messages from a list of points.
 * Simplifies the points using RDP and chunks them into small batches to avoid size limits.
 * @param {number[][]} points Path coordinates
 * @param {Object} colour {r, g, b}
 * @param {number[]} timingValues Random jitter values for performance/anti-detection
 * @param {Object} params Drawing configuration
 * @param {boolean} isEdge Whether this path is an edge (uses higher fidelity)
 * @returns {Object[]} Array of WebSocket payloads
 */
function buildDrawMsgs(points, colour, timingValues, params, isEdge = false) {
    const simplified = simplifyPath(points, isEdge ? 0.1 : params.simplify);
    const msgs = [];
    
    for (let i = 0; i < simplified.length; i += MAX_POINTS_PER_MSG) {
        const chunk = simplified.slice(i, i + MAX_POINTS_PER_MSG + 1);
        if (chunk.length < 2) continue;

        const lines = [];
        for (let j = 0; j < chunk.length; j++) {
            lines.push([chunk[j][0], chunk[j][1]]);
            // Insert periodic timing values used by Drawasaurus to pace the drawing
            if ((j + 1) % 4 === 0 && j < chunk.length - 1) {
                lines.push([timingValues[Math.floor(Math.random() * timingValues.length)]]);
            }
        }

        msgs.push({
            a: ["drawLine", {
                lines,
                colour: rgbToHex(colour.r, colour.g, colour.b),
                thick: isEdge ? 2 : params.thick
            }]
        });
    }
    return msgs;
}

// ============================================
//   SEND ALL DRAW MESSAGES
// ============================================

/**
 * Throttles and sends drawing messages over the WebSocket.
 * Includes adaptive delays based on message length and periodic longer pauses
 * to prevent rate-limiting or server-side disconnection.
 * @param {WebSocket} ws 
 * @param {Object[]} messages Array of 'drawLine' payloads
 */
async function sendDraw(ws, messages) {
    logDraw(`[Draw] Sending ${messages.length} drawLine messages...`);

    for (let i = 0; i < messages.length; i++) {
        if (ws.readyState !== WebSocket.OPEN) {
            logDraw(`[Draw] ❌ Disconnected at ${i}/${messages.length}`);
            if (i > 0) {
                console.log(`${BRIGHT}${CYAN}[Debug] Last successful message sent:${RESET}`, JSON.stringify(messages[i - 1]).substring(0, 500));
            }
            console.log(`${BRIGHT}${CYAN}[Debug] Message that failed to send:${RESET}`, JSON.stringify(messages[i]).substring(0, 500));
            return;
        }

        try {
            ws.lastSentMessage = messages[i];
            ws.send(JSON.stringify(messages[i]));
        } catch (err) {
            logDraw(`[Draw] ❌ Send Error at ${i}/${messages.length}: ${err.message}`);
            console.log(`${BRIGHT}${CYAN}[Debug] Payload at error:${RESET}`, JSON.stringify(messages[i]).substring(0, 500));
            throw err;
        }

        // Adaptive delay based on points in message
        const msgLen = messages[i].a[1].lines.length;
        const delay = Math.max(2, Math.min(10, Math.floor(msgLen / 2)));
        await new Promise(r => setTimeout(r, delay));
        
        // Batch pause for server breathing room
        if ((i + 1) % 100 === 0) {
            logDraw(`[Draw] Progress: ${i + 1}/${messages.length}`);
            await new Promise(r => setTimeout(r, 50));
        }
    }
    logDraw(`[Draw] ✅ ALL ${messages.length} messages sent!`);
}

// ============================================
//   MAIN
// ============================================

let reconnectCount = 0;
let ws = null;

// Console input handler for chatting in-game
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'Guess > '
});

rl.on('line', (line) => {
    const guess = line.trim();
    if (guess && ws && ws.readyState === WebSocket.OPEN) {
        logUser(`[You] ${guess}`);
        ws.send(JSON.stringify({ a: ["chat", guess] }));
    }
    rl.prompt();
});

/**
 * Main entry point: establishes WebSocket connection and handles game events.
 * Implements game state logic for:
 * - Joining rooms and picking usernames
 * - Choosing words automatically
 * - Pre-calculating drawings during the picking phase
 * - Drawing when it's the bot's turn
 * - Periodic ping/pong for heartbeats
 */
async function connect() {
    const wsUrl = `wss://server.drawasaurus.org/room/${encodeURIComponent(ROOM_NAME)}?version=${DRAWASAURUS_VERSION}`;
    logEvent(`[+] Connecting to "${ROOM_NAME}" (Attempt ${reconnectCount + 1}/${MAX_RECONNECT_ATTEMPTS + 1})...`);

    ws = new WebSocket(wsUrl, {
        headers: {
            'Origin': 'https://www.drawasaurus.org',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    let drawSent = false;
    let isMyTurn = false;

    ws.on('open', () => {
        logEvent('[+] Connected');
        reconnectCount = 0; // Reset counter on successful connection
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
                ws.send(JSON.stringify({ a: ["joinRoom", ROOM_NAME, ""] }));
            }

            // EVENT: It's our turn to pick a word
            if (event === 'showWordPicker') {
                try {
                    const wordsList = JSON.parse(args[0]);
                    const selectedWord = wordsList[0][0];
                    logDraw(`[Game] Automatically picking: "${selectedWord}"`);
                    ws.send(JSON.stringify({ a: ["chooseWord", 0] }));
                    
                    // Start processing the image IMMEDIATELY after picking to save time
                    (async () => {
                        try {
                            ws.currentDrawMessages = await searchAndProcessImage(selectedWord);
                        } catch (err) {
                            console.error(`[Draw] Automation failed: ${err.message}`);
                        }
                    })();
                } catch (e) { }
            }

            // EVENT: The drawing phase has started
            if (event === 'youDrawing') {
                const word = args[0];
                isMyTurn = true;
                if (!drawSent) {
                    drawSent = true;
                    (async () => {
                        // If we haven't finished processing the image from the picker phase, do it now
                        if (!ws.currentDrawMessages) {
                            try { ws.currentDrawMessages = await searchAndProcessImage(word); } catch (err) { return; }
                        }
                        await sendDraw(ws, ws.currentDrawMessages);
                        ws.currentDrawMessages = null;
                    })();
                }
            }

            // EVENT: Round over, reset local flags
            if (event === 'endRound') {
                drawSent = false;
                isMyTurn = false;
                ws.currentDrawMessages = null;
            }

            // Filter out noisy game events from console logs
            const silent = ['timerUpdate', 'ping', 'drawLine', 'drawCanvas', 'drawFill', 'drawClear',
                'updateUsers', 'setUsername', 'joinedRoom', 'prepareDrawing',
                'showWordPicker', 'startDrawing', 'endRound', 'youDrawing'];
            
            if (!silent.includes(event)) {
                if (event === 'chat') {
                    const sender = args[0];
                    const text = args[1];
                    if (!(sender === USERNAME || sender.startsWith(USERNAME))) {
                        logEvent(`[Chat] ${sender}: ${text}`);
                    }
                }
            }
        } catch (err) { }
    });

    ws.on('error', (err) => {
        console.error(`[!] Error: ${err.message}`);
        if (ws.lastSentMessage) {
            console.log(`${BRIGHT}${CYAN}[Debug] Last sent payload before error:${RESET}`, JSON.stringify(ws.lastSentMessage).substring(0, 500));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[!] Disconnected (Code: ${code}, Reason: ${reason})`);
        if (reconnectCount < MAX_RECONNECT_ATTEMPTS) {
            reconnectCount++;
            const delay = 5000 * reconnectCount;
            logEvent(`[+] Attempting reconnection in ${delay/1000}s...`);
            setTimeout(connect, delay);
        } else {
            logEvent(`[!] Max reconnection attempts reached.`);
            process.exit(1);
        }
    });

    // Heartbeat to keep connection alive
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ a: ["ping"] }));
    }, 20000);
}

process.on('SIGINT', () => {
    rl.close();
    if (ws) ws.close();
    process.exit(0);
});

connect().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
