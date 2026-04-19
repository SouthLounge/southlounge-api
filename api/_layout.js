// ============================================================
// FigGen Layout Optimizer
// Post-processes Claude's scene graph JSON to fix layout issues.
// ============================================================

const MARGIN = 40;
const GRID = 4; // snap to 4px grid
const LABEL_PADDING = 20; // clearance for labels outside nodes
const CAPTION_RESERVED = 35; // space at bottom for caption

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
            return {
                x: node.x,
                y: node.y,
                w: node.width || 120,
                h: h,
            };
        }
        case 'circle_op': {
            const r = node.r || 16;
            return {
                x: node.x - r,
                y: node.y - r,
                w: r * 2,
                h: r * 2,
            };
        }
        case 'text_label':
            // Approximate text bbox
            return {
                x: node.x - 50,
                y: node.y - 10,
                w: 100,
                h: 16,
            };
        case 'dots':
            return {
                x: node.x - 4,
                y: node.y - 4,
                w: node.direction === 'horizontal' ? (node.spacing || 8) * 2 + 8 : 8,
                h: node.direction === 'vertical' ? (node.spacing || 8) * 2 + 8 : 8,
            };
        default:
            return null;
    }
}

function bboxOverlap(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

function bboxCenter(bbox) {
    return { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 };
}

// ---- Grid Snapping ----

function snapToGrid(val) {
    return Math.round(val / GRID) * GRID;
}

function snapNodeToGrid(node) {
    if (node.kind === 'circle_op') {
        node.x = snapToGrid(node.x);
        node.y = snapToGrid(node.y);
    } else if (node.kind === 'arrow' || node.kind === 'dots') {
        // arrows handled separately, dots snap position
        if (node.kind === 'dots') {
            node.x = snapToGrid(node.x);
            node.y = snapToGrid(node.y);
        }
    } else if (node.x !== undefined && node.y !== undefined) {
        node.x = snapToGrid(node.x);
        node.y = snapToGrid(node.y);
    }
}

// ---- Near-Alignment Snapping ----
// If two nodes are within threshold of sharing an x or y, snap them to align

function alignNearbyNodes(nodes, threshold = 8) {
    const positionalNodes = nodes.filter(n =>
        n.kind !== 'arrow' && n.kind !== 'container' && n.x !== undefined
    );

    // Group by approximate x-center
    for (let i = 0; i < positionalNodes.length; i++) {
        const bboxI = getNodeBBox(positionalNodes[i]);
        if (!bboxI) continue;
        const cxI = bboxCenter(bboxI).x;

        for (let j = i + 1; j < positionalNodes.length; j++) {
            const bboxJ = getNodeBBox(positionalNodes[j]);
            if (!bboxJ) continue;
            const cxJ = bboxCenter(bboxJ).x;

            // If centers are close, align to average
            if (Math.abs(cxI - cxJ) < threshold && Math.abs(cxI - cxJ) > 0) {
                const avg = snapToGrid((cxI + cxJ) / 2);
                // Shift both nodes so their centers align
                const shiftI = avg - cxI;
                const shiftJ = avg - cxJ;
                shiftNodeX(positionalNodes[i], shiftI);
                shiftNodeX(positionalNodes[j], shiftJ);
            }
        }
    }

    // Group by approximate y-center
    for (let i = 0; i < positionalNodes.length; i++) {
        const bboxI = getNodeBBox(positionalNodes[i]);
        if (!bboxI) continue;
        const cyI = bboxCenter(bboxI).y;

        for (let j = i + 1; j < positionalNodes.length; j++) {
            const bboxJ = getNodeBBox(positionalNodes[j]);
            if (!bboxJ) continue;
            const cyJ = bboxCenter(bboxJ).y;

            if (Math.abs(cyI - cyJ) < threshold && Math.abs(cyI - cyJ) > 0) {
                const avg = snapToGrid((cyI + cyJ) / 2);
                const shiftI = avg - cyI;
                const shiftJ = avg - cyJ;
                shiftNodeY(positionalNodes[i], shiftI);
                shiftNodeY(positionalNodes[j], shiftJ);
            }
        }
    }
}

function shiftNodeX(node, dx) {
    if (node.kind === 'circle_op') {
        node.x += dx;
    } else if (node.x !== undefined) {
        node.x = snapToGrid(node.x + dx);
    }
}

function shiftNodeY(node, dy) {
    if (node.kind === 'circle_op') {
        node.y += dy;
    } else if (node.y !== undefined) {
        node.y = snapToGrid(node.y + dy);
    }
}

// ---- Margin Enforcement ----

function enforceMargins(nodes, canvasW, canvasH) {
    const titleReserved = 45; // space for title at top

    for (const node of nodes) {
        if (node.kind === 'arrow') continue;

        const bbox = getNodeBBox(node);
        if (!bbox) continue;

        // Check label space above stacked_blocks
        const needsTopLabel = (node.kind === 'stacked_block' && node.label && node.label_position !== 'bottom');
        const topMargin = needsTopLabel ? MARGIN + LABEL_PADDING : Math.max(MARGIN, titleReserved);
        const bottomReserve = canvasH - MARGIN - CAPTION_RESERVED;

        let dx = 0, dy = 0;

        // Left margin
        if (bbox.x < MARGIN) dx = MARGIN - bbox.x;
        // Right margin
        if (bbox.x + bbox.w > canvasW - MARGIN) dx = (canvasW - MARGIN - bbox.w) - bbox.x;
        // Top margin
        if (bbox.y < topMargin) dy = topMargin - bbox.y;
        // Bottom margin (reserve space for caption)
        if (bbox.y + bbox.h > bottomReserve) dy = bottomReserve - bbox.h - bbox.y;

        if (dx !== 0) shiftNodeX(node, dx);
        if (dy !== 0) shiftNodeY(node, dy);
    }
}

// ---- Overlap Resolution ----

function resolveOverlaps(nodes, iterations = 3) {
    const movable = nodes.filter(n =>
        n.kind !== 'arrow' && n.kind !== 'container' && n.kind !== 'text_label'
    );

    for (let iter = 0; iter < iterations; iter++) {
        let moved = false;

        for (let i = 0; i < movable.length; i++) {
            const bboxI = getNodeBBox(movable[i]);
            if (!bboxI) continue;

            for (let j = i + 1; j < movable.length; j++) {
                const bboxJ = getNodeBBox(movable[j]);
                if (!bboxJ) continue;

                if (!bboxOverlap(bboxI, bboxJ)) continue;

                // Calculate overlap amount
                const overlapX = Math.min(bboxI.x + bboxI.w, bboxJ.x + bboxJ.w) - Math.max(bboxI.x, bboxJ.x);
                const overlapY = Math.min(bboxI.y + bboxI.h, bboxJ.y + bboxJ.h) - Math.max(bboxI.y, bboxJ.y);

                // Push apart along the axis with less overlap (cheaper to fix)
                const padding = 12;
                if (overlapX < overlapY) {
                    const push = (overlapX + padding) / 2;
                    if (bboxCenter(bboxI).x < bboxCenter(bboxJ).x) {
                        shiftNodeX(movable[i], -push);
                        shiftNodeX(movable[j], push);
                    } else {
                        shiftNodeX(movable[i], push);
                        shiftNodeX(movable[j], -push);
                    }
                } else {
                    const push = (overlapY + padding) / 2;
                    if (bboxCenter(bboxI).y < bboxCenter(bboxJ).y) {
                        shiftNodeY(movable[i], -push);
                        shiftNodeY(movable[j], push);
                    } else {
                        shiftNodeY(movable[i], push);
                        shiftNodeY(movable[j], -push);
                    }
                }
                moved = true;
            }
        }

        if (!moved) break;
    }
}

// ---- Arrow Endpoint Correction ----
// Snap arrow start/end points to the nearest edge of their target node

function getEdgePoint(bbox, fromPoint) {
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    const dx = fromPoint.x - cx;
    const dy = fromPoint.y - cy;

    if (Math.abs(dx) === 0 && Math.abs(dy) === 0) {
        return { x: cx, y: bbox.y }; // default to top
    }

    // Determine which edge the line intersects
    const aspectRatio = bbox.w / bbox.h;
    if (Math.abs(dx) / (bbox.w / 2) > Math.abs(dy) / (bbox.h / 2)) {
        // Hits left or right edge
        if (dx > 0) {
            return { x: bbox.x + bbox.w, y: cy + dy * (bbox.w / 2) / Math.abs(dx) };
        } else {
            return { x: bbox.x, y: cy - dy * (bbox.w / 2) / Math.abs(dx) };
        }
    } else {
        // Hits top or bottom edge
        if (dy > 0) {
            return { x: cx + dx * (bbox.h / 2) / Math.abs(dy), y: bbox.y + bbox.h };
        } else {
            return { x: cx - dx * (bbox.h / 2) / Math.abs(dy), y: bbox.y };
        }
    }
}

function findClosestNode(point, nodes) {
    let closest = null;
    let minDist = Infinity;

    for (const node of nodes) {
        if (node.kind === 'arrow' || node.kind === 'text_label') continue;

        const bbox = getNodeBBox(node);
        if (!bbox) continue;

        const cx = bbox.x + bbox.w / 2;
        const cy = bbox.y + bbox.h / 2;
        const dist = Math.sqrt((point.x - cx) ** 2 + (point.y - cy) ** 2);

        // Only consider nodes reasonably close to the arrow point
        if (dist < minDist && dist < 150) {
            minDist = dist;
            closest = { node, bbox };
        }
    }

    return closest;
}

function correctArrowEndpoints(nodes) {
    const arrows = nodes.filter(n => n.kind === 'arrow');
    const targets = nodes.filter(n => n.kind !== 'arrow');

    for (const arrow of arrows) {
        if (!arrow.points || arrow.points.length < 2) continue;

        const startPt = { x: arrow.points[0][0], y: arrow.points[0][1] };
        const endPt = { x: arrow.points[arrow.points.length - 1][0], y: arrow.points[arrow.points.length - 1][1] };

        // Find closest node to start point
        const startTarget = findClosestNode(startPt, targets);
        if (startTarget) {
            // Compute edge point from the direction of the second point
            const nextPt = arrow.points.length > 1
                ? { x: arrow.points[1][0], y: arrow.points[1][1] }
                : endPt;
            const edgePt = getEdgePoint(startTarget.bbox, nextPt);
            arrow.points[0] = [snapToGrid(edgePt.x), snapToGrid(edgePt.y)];
        }

        // Find closest node to end point
        const endTarget = findClosestNode(endPt, targets);
        if (endTarget) {
            const prevPt = arrow.points.length > 1
                ? { x: arrow.points[arrow.points.length - 2][0], y: arrow.points[arrow.points.length - 2][1] }
                : startPt;
            const edgePt = getEdgePoint(endTarget.bbox, prevPt);
            arrow.points[arrow.points.length - 1] = [snapToGrid(edgePt.x), snapToGrid(edgePt.y)];
        }
    }
}

// ---- Canvas Auto-Resize ----
// If content overflows, expand the canvas

function autoResizeCanvas(sceneGraph) {
    const nodes = sceneGraph.nodes || [];
    let maxX = 0;
    let maxY = 0;

    for (const node of nodes) {
        if (node.kind === 'arrow') {
            for (const pt of (node.points || [])) {
                maxX = Math.max(maxX, pt[0]);
                maxY = Math.max(maxY, pt[1]);
            }
            continue;
        }

        const bbox = getNodeBBox(node);
        if (!bbox) continue;
        maxX = Math.max(maxX, bbox.x + bbox.w);
        maxY = Math.max(maxY, bbox.y + bbox.h);
    }

    // Add margin + caption space
    const neededW = maxX + MARGIN;
    const neededH = maxY + MARGIN + (sceneGraph.caption ? CAPTION_RESERVED : 10);

    if (neededW > sceneGraph.width) {
        sceneGraph.width = snapToGrid(neededW);
    }
    if (neededH > sceneGraph.height) {
        sceneGraph.height = snapToGrid(neededH);
    }

    // Clamp to reasonable max
    sceneGraph.width = Math.min(sceneGraph.width, 1200);
    sceneGraph.height = Math.min(sceneGraph.height, 900);
}

// ---- Spacing Regularization ----
// For nodes that form a horizontal or vertical row, equalize spacing

function regularizeSpacing(nodes) {
    const positional = nodes.filter(n =>
        n.kind !== 'arrow' && n.kind !== 'container' && n.kind !== 'text_label' && n.kind !== 'dots'
    );

    if (positional.length < 3) return;

    // Find horizontal rows (nodes with similar y-center, within 15px)
    const yGroups = {};
    for (const node of positional) {
        const bbox = getNodeBBox(node);
        if (!bbox) continue;
        const cy = Math.round(bboxCenter(bbox).y / 15) * 15;
        if (!yGroups[cy]) yGroups[cy] = [];
        yGroups[cy].push(node);
    }

    for (const key of Object.keys(yGroups)) {
        const group = yGroups[key];
        if (group.length < 3) continue;

        // Sort by x position
        group.sort((a, b) => {
            const ba = getNodeBBox(a);
            const bb = getNodeBBox(b);
            return (ba ? ba.x : 0) - (bb ? bb.x : 0);
        });

        // Compute average spacing between consecutive nodes
        const gaps = [];
        for (let i = 0; i < group.length - 1; i++) {
            const bboxA = getNodeBBox(group[i]);
            const bboxB = getNodeBBox(group[i + 1]);
            if (bboxA && bboxB) {
                gaps.push(bboxB.x - (bboxA.x + bboxA.w));
            }
        }

        if (gaps.length === 0) continue;
        const avgGap = snapToGrid(gaps.reduce((a, b) => a + b, 0) / gaps.length);
        if (avgGap < 10) continue; // too tight, skip

        // Check if gaps vary significantly (std > 15% of mean)
        const variance = gaps.reduce((sum, g) => sum + (g - avgGap) ** 2, 0) / gaps.length;
        const std = Math.sqrt(variance);
        if (std < avgGap * 0.15) continue; // already regular enough

        // Re-space: keep first node fixed, equalize gaps
        let currentX = getNodeBBox(group[0]).x + getNodeBBox(group[0]).w;
        for (let i = 1; i < group.length; i++) {
            const bbox = getNodeBBox(group[i]);
            if (!bbox) continue;
            const newX = snapToGrid(currentX + avgGap);
            const dx = newX - bbox.x;
            shiftNodeX(group[i], dx);
            currentX = newX + bbox.w;
        }
    }
}

// ---- Main Optimizer ----

export function optimizeLayout(sceneGraph) {
    const sg = JSON.parse(JSON.stringify(sceneGraph)); // deep clone
    const nodes = sg.nodes || [];

    if (nodes.length === 0) return sg;

    // Step 1: Snap all nodes to grid
    for (const node of nodes) {
        if (node.kind !== 'arrow') {
            snapNodeToGrid(node);
        }
    }
    // Snap arrow intermediate points
    for (const node of nodes) {
        if (node.kind === 'arrow' && node.points) {
            node.points = node.points.map(pt => [snapToGrid(pt[0]), snapToGrid(pt[1])]);
        }
    }

    // Step 2: Align near-aligned nodes
    alignNearbyNodes(nodes, 10);

    // Step 3: Resolve overlapping nodes
    resolveOverlaps(nodes, 4);

    // Step 4: Regularize spacing in rows
    regularizeSpacing(nodes);

    // Step 5: Enforce canvas margins
    enforceMargins(nodes, sg.width || 800, sg.height || 500);

    // Step 6: Correct arrow endpoints to snap to node edges
    correctArrowEndpoints(nodes);

    // Step 7: Auto-resize canvas if content overflows
    autoResizeCanvas(sg);

    return sg;
}
