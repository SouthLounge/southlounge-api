// ============================================================
// FigGen Layout Optimizer v2
// Conservative post-processing: fix overflows and snapping
// without rearranging Claude's intended layout.
// ============================================================

const MARGIN = 50;
const GRID = 4;
const TITLE_RESERVED = 50;
const CAPTION_RESERVED = 60;

// ---- Bounding Box Helpers ----

function getNodeBBox(node) {
    switch (node.kind) {
        case 'rect':
        case 'trapezoid':
        case 'container':
            return {
                x: node.x,
                y: node.y,
                w: node.width || 120,
                h: node.height || 50,
            };
        case 'stacked_block': {
            const layers = node.layers || [{}];
            const layerH = node.layer_height || 36;
            const gap = node.gap || 2;
            const h = layers.length * layerH + (layers.length - 1) * gap;
            return { x: node.x, y: node.y, w: node.width || 120, h };
        }
        case 'circle_op': {
            const r = node.r || 16;
            return { x: node.x - r, y: node.y - r, w: r * 2, h: r * 2 };
        }
        case 'text_label': {
            const fontSize = node.font_size || 13;
            const textLen = (node.text || node.label || '').length;
            const approxW = textLen * fontSize * 0.6;
            return { x: node.x - approxW / 2, y: node.y - fontSize, w: approxW, h: fontSize + 4 };
        }
        case 'tensor_block': {
            const depth = node.depth || 20;
            return {
                x: node.x,
                y: node.y - depth,
                w: (node.width || 80) + depth,
                h: (node.height || 60) + depth,
            };
        }
        case 'waveform':
            return {
                x: node.x,
                y: node.y - (node.amplitude || 12),
                w: node.width || 120,
                h: (node.height || 30) + (node.amplitude || 12) * 2,
            };
        case 'bracket': {
            if (node.direction === 'vertical') {
                return {
                    x: node.x - 20,
                    y: node.y,
                    w: 40,
                    h: node.height || 150,
                };
            }
            return {
                x: node.x,
                y: node.y - (node.tick_height || 8),
                w: node.width || 200,
                h: (node.tick_height || 8) + 20,
            };
        }
        case 'curved_arrow': {
            if (!node.points || node.points.length < 2) return null;
            let minPx = Infinity, minPy = Infinity, maxPx = 0, maxPy = 0;
            for (const pt of node.points) {
                minPx = Math.min(minPx, pt[0]);
                minPy = Math.min(minPy, pt[1]);
                maxPx = Math.max(maxPx, pt[0]);
                maxPy = Math.max(maxPy, pt[1]);
            }
            return { x: minPx, y: minPy, w: maxPx - minPx, h: maxPy - minPy };
        }
        case 'side_annotation': {
            const fontSize = node.font_size || 11;
            const textLen = (node.text || '').length;
            const approxW = textLen * fontSize * 0.6;
            const minAx = Math.min(node.x, node.target_x || node.x);
            const minAy = Math.min(node.y, node.target_y || node.y) - fontSize;
            const maxAx = Math.max(node.x + approxW, node.target_x || node.x);
            const maxAy = Math.max(node.y, node.target_y || node.y);
            return { x: minAx, y: minAy, w: maxAx - minAx, h: maxAy - minAy + fontSize };
        }
        case 'vertical_label': {
            const fs = node.font_size || 13;
            const tLen = (node.text || '').length;
            const approxH = tLen * fs * 0.6;
            return { x: node.x - fs, y: node.y - approxH / 2, w: fs + 4, h: approxH };
        }
        case 'repeat_marker': {
            const rfs = node.font_size || 13;
            return { x: node.x - 10, y: node.y - rfs / 2, w: 30, h: rfs + 4 };
        }
        case 'dots':
            return {
                x: node.x - 4, y: node.y - 4,
                w: node.direction === 'horizontal' ? (node.spacing || 8) * 2 + 8 : 8,
                h: node.direction === 'vertical' ? (node.spacing || 8) * 2 + 8 : 8,
            };
        default:
            return null;
    }
}

function snap(val) {
    return Math.round(val / GRID) * GRID;
}

// ---- Step 1: Compute content bounds and auto-resize canvas ----

function autoResizeCanvas(sg) {
    const nodes = sg.nodes || [];
    let maxX = 0, maxY = 0;
    let minX = Infinity, minY = Infinity;

    for (const node of nodes) {
        if (node.kind === 'arrow' || node.kind === 'curved_arrow') {
            for (const pt of (node.points || [])) {
                maxX = Math.max(maxX, pt[0]);
                maxY = Math.max(maxY, pt[1]);
                minX = Math.min(minX, pt[0]);
                minY = Math.min(minY, pt[1]);
            }
            continue;
        }
        const bbox = getNodeBBox(node);
        if (!bbox) continue;
        maxX = Math.max(maxX, bbox.x + bbox.w);
        maxY = Math.max(maxY, bbox.y + bbox.h);
        minX = Math.min(minX, bbox.x);
        minY = Math.min(minY, bbox.y);
    }

    // If content is too close to or beyond edges, expand canvas
    const neededW = maxX + MARGIN;
    // Estimate caption lines based on text length vs canvas width
    let captionSpace = 10;
    if (sg.caption) {
        const charWidth = 5.7; // approx for 11px font
        const maxCharsPerLine = Math.floor((sg.width || 800 - 80) / charWidth);
        const captionLines = Math.ceil(sg.caption.length / Math.max(maxCharsPerLine, 40));
        captionSpace = CAPTION_RESERVED + Math.max(0, captionLines - 2) * 15;
    }
    const neededH = maxY + MARGIN + captionSpace;

    sg.width = snap(Math.max(sg.width || 800, neededW));
    sg.height = snap(Math.max(sg.height || 500, neededH));

    // Clamp
    sg.width = Math.min(sg.width, 1400);
    sg.height = Math.min(sg.height, 1000);

    return { minX, minY, maxX, maxY };
}

// ---- Step 2: Shift everything if content starts before margins ----

function shiftContentIntoMargins(sg, bounds) {
    const nodes = sg.nodes || [];

    // If content starts before left margin or top margin, shift everything right/down
    const shiftX = bounds.minX < MARGIN ? snap(MARGIN - bounds.minX) : 0;
    const shiftY = bounds.minY < TITLE_RESERVED ? snap(TITLE_RESERVED - bounds.minY) : 0;

    if (shiftX === 0 && shiftY === 0) return;

    for (const node of nodes) {
        if (node.kind === 'arrow' || node.kind === 'curved_arrow') {
            if (node.points) {
                node.points = node.points.map(pt => [
                    snap(pt[0] + shiftX),
                    snap(pt[1] + shiftY),
                ]);
            }
            continue;
        }
        if (node.kind === 'circle_op') {
            node.x = snap(node.x + shiftX);
            node.y = snap(node.y + shiftY);
        } else if (node.x !== undefined) {
            node.x = snap(node.x + shiftX);
            node.y = snap(node.y + shiftY);
        }
    }

    // Resize canvas to accommodate shift
    autoResizeCanvas(sg);
}

// ---- Step 3: Grid-snap all coordinates ----

function gridSnapAll(nodes) {
    for (const node of nodes) {
        if (node.kind === 'arrow' || node.kind === 'curved_arrow') {
            if (node.points) {
                node.points = node.points.map(pt => [snap(pt[0]), snap(pt[1])]);
            }
        } else if (node.kind === 'circle_op') {
            node.x = snap(node.x);
            node.y = snap(node.y);
        } else if (node.kind === 'dots') {
            node.x = snap(node.x);
            node.y = snap(node.y);
        } else if (node.x !== undefined) {
            node.x = snap(node.x);
            node.y = snap(node.y);
            if (node.width) node.width = snap(node.width);
            if (node.height) node.height = snap(node.height);
        }
    }
}

// ---- Step 4: Light alignment pass ----
// Only align nodes that are VERY close (within 5px) and have similar sizes
// This avoids pulling unrelated nodes together

function lightAlign(nodes) {
    const positional = nodes.filter(n =>
        n.kind === 'rect' || n.kind === 'trapezoid' || n.kind === 'stacked_block'
    );

    if (positional.length < 2) return;

    // Only align left edges that are within 5px of each other
    for (let i = 0; i < positional.length; i++) {
        for (let j = i + 1; j < positional.length; j++) {
            const xi = positional[i].x;
            const xj = positional[j].x;

            if (Math.abs(xi - xj) > 0 && Math.abs(xi - xj) <= 5) {
                // Snap j to i's position (i is the anchor)
                positional[j].x = positional[i].x;
            }

            const yi = positional[i].y;
            const yj = positional[j].y;

            if (Math.abs(yi - yj) > 0 && Math.abs(yi - yj) <= 5) {
                positional[j].y = positional[i].y;
            }
        }
    }
}

// ---- Step 5: Ensure containers enclose their children ----
// If a container doesn't fully contain the nodes inside it, expand it

function fixContainers(nodes) {
    const containers = nodes.filter(n => n.kind === 'container');
    const others = nodes.filter(n => n.kind !== 'container' && n.kind !== 'arrow' && n.kind !== 'text_label');

    for (const container of containers) {
        const cBBox = getNodeBBox(container);
        if (!cBBox) continue;

        // Find nodes that are mostly inside this container
        const contained = [];
        for (const node of others) {
            const nBBox = getNodeBBox(node);
            if (!nBBox) continue;

            const nCx = nBBox.x + nBBox.w / 2;
            const nCy = nBBox.y + nBBox.h / 2;

            // Node center is inside container
            if (nCx > cBBox.x && nCx < cBBox.x + cBBox.w &&
                nCy > cBBox.y && nCy < cBBox.y + cBBox.h) {
                contained.push(nBBox);
            }
        }

        if (contained.length === 0) continue;

        // Check if any contained node extends beyond the container
        let needsExpand = false;
        let newX = cBBox.x, newY = cBBox.y;
        let newRight = cBBox.x + cBBox.w, newBottom = cBBox.y + cBBox.h;

        for (const nBBox of contained) {
            const pad = 15;
            if (nBBox.x - pad < newX) { newX = snap(nBBox.x - pad); needsExpand = true; }
            if (nBBox.y - pad < newY) { newY = snap(nBBox.y - pad); needsExpand = true; }
            if (nBBox.x + nBBox.w + pad > newRight) { newRight = snap(nBBox.x + nBBox.w + pad); needsExpand = true; }
            if (nBBox.y + nBBox.h + pad > newBottom) { newBottom = snap(nBBox.y + nBBox.h + pad); needsExpand = true; }
        }

        if (needsExpand) {
            container.x = newX;
            container.y = newY;
            container.width = newRight - newX;
            container.height = newBottom - newY;
        }
    }
}

// ---- Main Optimizer ----

export function optimizeLayout(sceneGraph) {
    const sg = JSON.parse(JSON.stringify(sceneGraph)); // deep clone
    const nodes = sg.nodes || [];

    if (nodes.length === 0 && !(sg.panels && sg.panels.length > 0)) return sg;

    // Step 1: Grid-snap all coordinates
    gridSnapAll(nodes);

    // Step 2: Light alignment (very conservative — only 5px threshold)
    lightAlign(nodes);

    // Step 3: Fix containers to enclose their children
    fixContainers(nodes);

    // Process panel nodes too
    if (sg.panels) {
        for (const panel of sg.panels) {
            const panelNodes = panel.nodes || [];
            gridSnapAll(panelNodes);
            lightAlign(panelNodes);
            fixContainers(panelNodes);
        }
    }

    // Step 4: Auto-resize canvas to fit all content
    const bounds = autoResizeCanvas(sg);

    // Step 5: Shift content into margins if it starts too early
    shiftContentIntoMargins(sg, bounds);

    return sg;
}
