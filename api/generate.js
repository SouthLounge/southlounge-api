import Anthropic from '@anthropic-ai/sdk';
import { optimizeLayout } from './_layout.js';

const SYSTEM_PROMPT = `You are a scientific figure generator. Given a paper's title and abstract, you produce a JSON scene graph that describes a publication-quality architecture/pipeline diagram.

## JSON Schema

Return ONLY valid JSON (no markdown, no code fences) with this structure:

{
  "width": 800,        // canvas width in px (600-1000)
  "height": 500,       // canvas height in px (400-700)
  "title": "...",       // figure title (short)
  "caption": "...",     // optional figure caption (1 sentence)
  "nodes": [...]        // array of node objects
}

## Node Types

Each node has a "kind" field. Available kinds:

### rect
{ "kind": "rect", "x": 100, "y": 100, "width": 120, "height": 50, "rx": 4, "label": "Module Name", "type_label": "ENCODER", "sublabel": "(optional detail)", "fill": null, "stroke": null, "bold": false }

### trapezoid
{ "kind": "trapezoid", "x": 100, "y": 100, "width": 120, "height": 55, "top_width": 72, "direction": "down", "label": "Encoder", "fill": null }
- direction: "down" = wider at bottom (encoder), "up" = wider at top (decoder)
- top_width: width of the top edge (bottom is always full width)

### stacked_block
{ "kind": "stacked_block", "x": 100, "y": 100, "width": 130, "layers": [{"label": "Layer 1"}, {"label": "Layer 2"}, {"label": "Layer 3"}], "layer_height": 36, "gap": 2, "label": "Block Name", "label_position": "bottom", "show_border": true }

### circle_op
{ "kind": "circle_op", "x": 300, "y": 200, "r": 18, "symbol": "⊕", "label": "Add" }
- symbol: "⊕" (add), "⊙" (hadamard), "×" (multiply), "σ" (sigmoid), "+" (sum), "·" (dot)

### arrow
{ "kind": "arrow", "points": [[x1,y1], [x2,y2], ...], "dashed": false, "label": "data flow", "label_offset_x": 8, "label_offset_y": -6, "color": null }
- points: array of [x,y] coordinate pairs. Arrow goes from first to last point.
- Use intermediate points for bends/routing.

### container
{ "kind": "container", "x": 50, "y": 50, "width": 200, "height": 300, "label": "Module Group", "label_position": "top", "dash_pattern": "6,4" }
- Dashed border rectangle to group related nodes.

### text_label
{ "kind": "text_label", "x": 400, "y": 480, "text": "L = L_recon + αL_kl", "anchor": "middle", "mono": true, "font_size": 12, "bold": false, "italic": true }

### dots
{ "kind": "dots", "x": 200, "y": 300, "direction": "vertical", "spacing": 8 }
- Three dots indicating continuation. direction: "vertical" or "horizontal".

## Design Principles

1. Use 5-15 nodes total. Be selective — show the KEY architecture, not every detail.
2. Use a grid-based layout: ~120px horizontal spacing, ~80px vertical spacing.
3. Leave 40px margins on all sides.
4. Use trapezoids for encoder/decoder pairs (down=encoder, up=decoder).
5. Use stacked_blocks for multi-layer modules (transformer blocks, ResNet stages).
6. Use circle_op for mathematical operations (attention, addition, gating).
7. Use containers to group related components.
8. Arrows should connect outputs to inputs. Route around nodes when needed.
9. Keep labels short (1-3 words). Use type_label for category, sublabel for detail.
10. The figure should tell the paper's story at a glance.
11. For fill/stroke/color: use null to inherit from the style theme. Only override if semantically important (e.g., different colors for different modalities).
12. Make arrow points connect to node edges, not centers. Account for node dimensions.

## Your Task

Read the paper title and abstract. Identify the core architecture or method pipeline. Produce a clean, readable diagram that a researcher would put in a paper. Focus on the main contribution — skip standard components like "Adam optimizer" or "cross-entropy loss" unless they are the paper's focus.`;

export default async function handler(req, res) {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', 'https://southlounge.github.io');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { arxiv_url, style, include_caption, include_legend } = req.body;

    if (!arxiv_url) {
        return res.status(400).json({ error: 'arxiv_url is required' });
    }

    // Extract arXiv ID
    const match = arxiv_url.match(/(\d{4}\.\d{4,5})(v\d+)?/);
    if (!match) {
        return res.status(400).json({ error: 'Invalid arXiv URL — could not extract paper ID' });
    }
    const arxivId = match[1];

    try {
        // Fetch abstract from arXiv API
        const arxivApiUrl = `https://export.arxiv.org/api/query?id_list=${arxivId}`;
        const arxivRes = await fetch(arxivApiUrl);
        const arxivXml = await arxivRes.text();

        // Check for rate limiting
        if (arxivXml.includes('Rate exceeded') || !arxivRes.ok) {
            return res.status(429).json({ error: 'arXiv rate limit hit — wait a few seconds and try again' });
        }

        // Parse title and summary from Atom XML
        const titleMatch = arxivXml.match(/<title>([\s\S]*?)<\/title>/g);
        const summaryMatch = arxivXml.match(/<summary>([\s\S]*?)<\/summary>/);

        // First <title> is feed title, second is paper title
        let paperTitle = 'Unknown Paper';
        if (titleMatch && titleMatch.length >= 2) {
            paperTitle = titleMatch[1]
                .replace(/<\/?title>/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        }

        let abstract = '';
        if (summaryMatch) {
            abstract = summaryMatch[1].replace(/\s+/g, ' ').trim();
        }

        if (!abstract) {
            return res.status(400).json({ error: 'Could not find abstract — check the arXiv ID is valid' });
        }

        // Build user prompt
        let userPrompt = `Paper Title: ${paperTitle}\n\nAbstract: ${abstract}\n\nStyle: ${style || 'icml'}`;
        if (include_caption) {
            userPrompt += '\n\nInclude a descriptive caption in the "caption" field.';
        } else {
            userPrompt += '\n\nDo not include a caption (omit "caption" field or set to null).';
        }
        if (include_legend) {
            userPrompt += '\nInclude a legend using text_label nodes in the bottom-right area explaining any color coding or symbols used.';
        }

        // Call Claude API
        const client = new Anthropic();

        const message = await client.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }],
        });

        // Extract JSON from response
        const responseText = message.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('');

        // Try to parse JSON — handle possible markdown code fences
        let sceneGraph;
        try {
            sceneGraph = JSON.parse(responseText);
        } catch {
            // Try extracting from code fence
            const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                sceneGraph = JSON.parse(jsonMatch[1].trim());
            } else {
                throw new Error('Failed to parse scene graph JSON from Claude response');
            }
        }

        const optimized = optimizeLayout(sceneGraph);

        return res.status(200).json({
            scene_graph: optimized,
            paper_title: paperTitle,
            arxiv_id: arxivId,
        });
    } catch (err) {
        console.error('Error generating figure:', err);
        return res.status(500).json({
            error: err.message || 'Internal server error',
        });
    }
}
