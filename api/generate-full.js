import Anthropic from '@anthropic-ai/sdk';
import { parse } from 'node-html-parser';
import { optimizeLayout } from './_layout.js';

const SYSTEM_PROMPT = `You are a scientific figure generator. Given a paper's title, abstract, and selected sections from the full paper, you produce a JSON scene graph that describes a publication-quality architecture/pipeline diagram.

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

You have access to the paper's full text (selected sections). Use specific architectural component names, layer counts, dimensions, and module names mentioned in the paper. Pay special attention to the Methods/Model section for architectural details. If the paper describes a multi-stage pipeline, show all stages with their specific names. Produce a clean, readable diagram that a researcher would put in a paper. Focus on the main contribution — skip standard components like "Adam optimizer" or "cross-entropy loss" unless they are the paper's focus.`;

// Keywords that indicate a section is relevant for figure generation
const RELEVANT_KEYWORDS = [
    'introduction', 'intro',
    'method', 'methodology', 'approach',
    'model', 'architecture', 'framework',
    'system', 'design', 'overview',
    'proposed', 'our approach',
    'network', 'pipeline',
    'preliminary', 'background',
    'formulation', 'problem',
];

const SKIP_KEYWORDS = [
    'related work', 'prior work', 'literature',
    'acknowledgment', 'acknowledgement',
    'reference', 'bibliography',
    'appendix', 'supplementary',
    'ethics', 'broader impact',
    'limitation',
];

const MAX_CHARS = 40000; // ~15K tokens

function selectRelevantSections(sections) {
    const selected = [];
    let totalChars = 0;

    for (const section of sections) {
        const headingLower = section.heading.toLowerCase();

        // Always include abstract
        if (headingLower.includes('abstract')) {
            selected.push(section);
            totalChars += section.text.length;
            continue;
        }

        // Skip sections we don't need
        if (SKIP_KEYWORDS.some(kw => headingLower.includes(kw))) {
            continue;
        }

        // Include sections with relevant keywords
        const isRelevant = RELEVANT_KEYWORDS.some(kw => headingLower.includes(kw));

        // Include numbered first sections (likely intro) and method sections
        const sectionNum = headingLower.match(/^(\d+)/);
        const isEarlySection = sectionNum && parseInt(sectionNum[1]) <= 4;

        if (isRelevant || isEarlySection) {
            if (totalChars + section.text.length > MAX_CHARS) {
                // Truncate this section to fit
                const remaining = MAX_CHARS - totalChars;
                if (remaining > 200) {
                    selected.push({
                        heading: section.heading,
                        text: section.text.slice(0, remaining) + '... [truncated]',
                    });
                }
                break;
            }
            selected.push(section);
            totalChars += section.text.length;
        }
    }

    return selected;
}

function extractSectionsFromHTML(html) {
    const root = parse(html);
    const sections = [];

    // Try to get title
    const titleEl = root.querySelector('h1') || root.querySelector('.ltx_title');
    const title = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';

    // Try to get abstract
    const abstractEl = root.querySelector('.ltx_abstract') || root.querySelector('.abstract');
    if (abstractEl) {
        sections.push({
            heading: 'Abstract',
            text: abstractEl.textContent.replace(/\s+/g, ' ').trim(),
        });
    }

    // Walk section headings (h2, h3) and collect their content
    const headings = root.querySelectorAll('h2, h3, .ltx_title_section, .ltx_title_subsection');

    for (const heading of headings) {
        const headingText = heading.textContent.replace(/\s+/g, ' ').trim();
        if (!headingText) continue;

        // Collect text from sibling elements until next heading
        let text = '';
        let sibling = heading.parentNode;

        // For ar5iv, sections are wrapped in <section> or <div class="ltx_section">
        if (sibling && (sibling.classNames?.includes('ltx_section') || sibling.tagName === 'SECTION')) {
            const paragraphs = sibling.querySelectorAll('p, .ltx_para');
            text = paragraphs.map(p => p.textContent.replace(/\s+/g, ' ').trim()).join('\n');
        } else {
            // Fallback: walk next siblings
            let next = heading.nextElementSibling;
            while (next && !['H2', 'H3', 'H4'].includes(next.tagName)) {
                if (next.tagName === 'P' || next.classNames?.includes('ltx_para')) {
                    text += next.textContent.replace(/\s+/g, ' ').trim() + '\n';
                }
                next = next.nextElementSibling;
            }
        }

        if (text.trim()) {
            sections.push({ heading: headingText, text: text.trim() });
        }
    }

    return { title, sections };
}

async function fetchFullText(arxivId) {
    // Strategy 1: ar5iv HTML
    try {
        const ar5ivRes = await fetch(`https://ar5iv.labs.arxiv.org/html/${arxivId}`, {
            headers: { 'User-Agent': 'FigGen/1.0 (scientific figure generator)' },
        });
        if (ar5ivRes.ok) {
            const html = await ar5ivRes.text();
            if (!html.includes('Conversion Error') && html.length > 1000) {
                const { title, sections } = extractSectionsFromHTML(html);
                if (sections.length > 0) {
                    return { title, sections, source: 'ar5iv' };
                }
            }
        }
    } catch (e) {
        // Fall through to next strategy
    }

    // Strategy 2: arXiv native HTML
    try {
        const arxivHtmlRes = await fetch(`https://arxiv.org/html/${arxivId}`, {
            headers: { 'User-Agent': 'FigGen/1.0 (scientific figure generator)' },
        });
        if (arxivHtmlRes.ok) {
            const html = await arxivHtmlRes.text();
            if (html.length > 1000) {
                const { title, sections } = extractSectionsFromHTML(html);
                if (sections.length > 0) {
                    return { title, sections, source: 'arxiv-html' };
                }
            }
        }
    } catch (e) {
        // Fall through to PDF
    }

    // Strategy 3: PDF extraction
    try {
        const pdfRes = await fetch(`https://arxiv.org/pdf/${arxivId}.pdf`, {
            headers: { 'User-Agent': 'FigGen/1.0 (scientific figure generator)' },
        });
        if (!pdfRes.ok) {
            throw new Error(`PDF fetch failed: ${pdfRes.status}`);
        }

        const pdfBuffer = await pdfRes.arrayBuffer();

        // Dynamic import for unpdf (ESM)
        const { extractText } = await import('unpdf');
        const { text } = await extractText(new Uint8Array(pdfBuffer));

        if (!text || text.length < 100) {
            throw new Error('PDF text extraction returned empty result');
        }

        // For PDF, we don't have section structure — send as one block
        // but try to split on common section heading patterns
        const sections = [];
        const sectionPattern = /\n(\d+\.?\s+[A-Z][A-Za-z\s]+)\n/g;
        let lastIndex = 0;
        let lastHeading = 'Full Paper';
        let match;

        while ((match = sectionPattern.exec(text)) !== null) {
            if (match.index > lastIndex) {
                sections.push({
                    heading: lastHeading,
                    text: text.slice(lastIndex, match.index).replace(/\s+/g, ' ').trim(),
                });
            }
            lastHeading = match[1].trim();
            lastIndex = match.index + match[0].length;
        }

        // Add last section
        if (lastIndex < text.length) {
            sections.push({
                heading: lastHeading,
                text: text.slice(lastIndex).replace(/\s+/g, ' ').trim(),
            });
        }

        // If no sections were found, just use the whole text
        if (sections.length === 0) {
            sections.push({ heading: 'Full Paper', text: text.replace(/\s+/g, ' ').trim() });
        }

        // Try to extract title from first line
        const firstLine = text.split('\n').find(l => l.trim().length > 10);
        const title = firstLine ? firstLine.trim().slice(0, 200) : '';

        return { title, sections, source: 'pdf' };
    } catch (e) {
        throw new Error(`All extraction methods failed. Last error: ${e.message}`);
    }
}

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
        // Fetch full paper text
        const { title: paperTitle, sections, source } = await fetchFullText(arxivId);

        // Select relevant sections and truncate
        const relevantSections = selectRelevantSections(sections);

        if (relevantSections.length === 0) {
            return res.status(400).json({ error: 'Could not extract meaningful text from paper' });
        }

        // Build paper text from sections
        const paperText = relevantSections
            .map(s => `## ${s.heading}\n${s.text}`)
            .join('\n\n');

        // Build user prompt
        let userPrompt = `Paper Title: ${paperTitle || 'Unknown'}\n\n${paperText}\n\nStyle: ${style || 'icml'}`;
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
            paper_title: paperTitle || 'Unknown Paper',
            arxiv_id: arxivId,
            source: source,
        });
    } catch (err) {
        console.error('Error generating figure (full):', err);
        return res.status(500).json({
            error: err.message || 'Internal server error',
        });
    }
}
