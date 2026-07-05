(function() {
  'use strict';

  // ── State ──
  let vaultRoot = null;
  let vaultPath = '';
  let files = {};          // relativePath -> content
  let nodes = [];          // {id, path, name, x, y, z, radius, color, inDegree, outDegree}
  let tagNodes = [];       // {id, name, x, y, z, color, fileCount}
  let edges = [];          // {source, target}
  let showLines = true;
  let showLabels = true;
  let threeInitialized = false;
  let cameraDefaultPos = { x: 0, y: 30, z: 120 };
  let selectedNode = null;
  let highlightedTagId = null;
  let highlightedPlanetId = null;
  let highlightedLines = [];  // lines currently highlighted
  let highlightedIds = new Set();
  let mouseDownPos = { x: 0, y: 0 };
  let isMouseDragging = false;
  let tagMeshes = [];      // Three.js groups for tag nodes
  let tagLabelSprites = [];  // Canvas-texture sprites for tag labels
  let planetLabelSprites = []; // Canvas-texture sprites for planet labels
  let fileTagsMap = new Map(); // filePath -> Set of tag names
  let nodeMap = new Map(); // id -> node (for O(1) lookups)
  let fileInput = null; // reusable file input element

  // ── Navigation history ──
  let navHistory = [];      // {view, nodeId, cameraPos, controlsTarget, mdScrollTop, mdFilename}
  let navHistoryIdx = -1;
  let isNavigatingHistory = false;

  // ── Three.js globals ──
  let scene, camera, renderer, controls;
  let planetMeshes = [];
  let lineSegments = [];
  let raycaster, mouse;
  let minimapCtx;
  let frameCount = 0;
  let lastFpsTime = performance.now();

  // ── DOM refs ──
  const overlay = document.getElementById('loading-overlay');
  const app = document.getElementById('app');
  const viewport = document.getElementById('viewport3d');
  const mdPanel = document.getElementById('md-panel');
  const mdContent = document.getElementById('md-content');
  const mdFilename = document.getElementById('md-filename');
  const tooltip = document.getElementById('tooltip');
  const minimapCanvas = document.getElementById('minimap-canvas');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const statusFiles = document.getElementById('status-files');
  const statusLinks = document.getElementById('status-links');
  const statusFps = document.getElementById('status-fps');

  // ── Cyberpunk color palette for planets ──
  const PLANET_COLORS = [
    0x00f0ff, 0xff00aa, 0xb400ff, 0x00ff88, 0xffe600,
    0xff4444, 0x44aaff, 0xff8800, 0x88ff00, 0xff0066,
    0x00ccff, 0xcc00ff, 0x00ff44, 0xffaa00, 0x44ffaa,
    0xaa00ff, 0xff6600, 0x00ffcc, 0xff0088, 0x66ff00
  ];

  // ── Tag color palette (distinct from planet colors) ──
  const TAG_COLORS = [
    0xffd700, 0xff6b6b, 0x4ecdc4, 0xa8e6cf, 0xff8a5c,
    0x7c83fd, 0xf7b731, 0x546de5, 0x26de97, 0xfd9644,
    0xc4e538, 0xef5777, 0x63c9af, 0x3dc1d3, 0xe15f41,
    0x778beb, 0xffb347, 0x82c4e0, 0xb5e48c, 0xe8a0bf
  ];

  // ═══════════════════════════════════════
  //  File System Access
  // ═══════════════════════════════════════

  async function openVault() {
    try {
      // Use the file input approach — works reliably across Chrome, Edge, Opera
      // Reusable file input element (avoids DOM churn)
      if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.webkitdirectory = true;
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);
      }
      // Clear previous result to allow re-selecting same files
      fileInput.value = '';

      const result = await new Promise(resolve => {
        fileInput.onchange = () => resolve(fileInput.files);
        fileInput.click();
      });

      if (!result || result.length === 0) {
        console.log('No files selected');
        return;
      }

      console.log('File Input:', result.length, 'files selected');
      await readFilesFromInput(result);
      vaultPath = 'selected';
      showApp();
    } catch (err) {
      console.error('Failed to open vault:', err);
      document.getElementById('loading-overlay').querySelector('.loader-text').textContent =
        'Fehler: ' + err.message;
    }
  }

  async function readFilesFromInput(filesList) {
    files = {};
    for (let i = 0; i < filesList.length; i++) {
      const file = filesList[i];
      if (!file.name.endsWith('.md')) continue;
      const path = file.webkitRelativePath;
      const content = await readFileAsText(file);
      files[path] = content;
    }
    console.log('=== readFilesFromInput abgeschlossen ===');
    console.log('Files found:', Object.keys(files).length);
    console.log('File paths:', Object.keys(files).slice(0, 10));
    buildGraph();
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(file, 'utf-8');
    });
  }

  async function readFileContent(relPath) {
    // Files are already loaded into memory via the file input approach
    return files[relPath] || null;
  }

  // ═══════════════════════════════════════
  //  Tag Parsing
  // ═══════════════════════════════════════

  function parseTags(content) {
    const tagSet = new Set();

    // 1. Frontmatter tags: tags: [a, b, c] or tags:\n  - a\n  - b
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      // Array form: tags: [tag1, tag2]
      const arrMatch = fm.match(/tags:\s*\[([^\]]+)\]/);
      if (arrMatch) {
        arrMatch[1].split(',').forEach(t => {
          const tag = t.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
          if (tag) tagSet.add(tag);
        });
      }
      // List form: tags:\n  - tag1\n  - tag2
      const listMatches = fm.matchAll(/tags:\s*\n((?:\s*-\s*[^\n]+\n?)+)/g);
      for (const lm of listMatches) {
        lm[1].match(/-\s*([^\n]+)/g)?.forEach(m => {
          const tag = m.replace(/^-\s*/, '').trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
          if (tag) tagSet.add(tag);
        });
      }
    }

    // 2. Inline tags: #tagname (not inside [[...]])
    const inlineRegex = /(?<!\[)#([a-zA-Z0-9_\u00C0-\u024F\u3040-\u30FF\u4E00-\u9FFF][a-zA-Z0-9_\u00C0-\u024F\u3040-\u30FF\u4E00-\u9FFF]*)/g;
    let match;
    while ((match = inlineRegex.exec(content)) !== null) {
      tagSet.add(match[1]);
    }

    return tagSet;
  }

  // ═══════════════════════════════════════
  //  Wikilink Parsing
  // ═══════════════════════════════════════

  function parseWikilinks(content) {
    const links = [];
    const regex = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      let target = match[1];
      // Unescape \| → | (table-escaped pipes in Obsidian)
      target = target.replace(/\\\|/g, '|');
      // Remove alias after |
      const aliasIdx = target.indexOf('|');
      if (aliasIdx !== -1) target = target.substring(0, aliasIdx);
      // Remove prefix like "Dateien/" etc.
      links.push(target);
    }
    return links;
  }

  // ═══════════════════════════════════════
  //  Markdown Rendering
  // ═══════════════════════════════════════

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMarkdown(content) {
    if (!content) return '';

    // ── Pre-process: convert Obsidian-specific syntax before marked parses ──

    // 0. Remove YAML frontmatter (--- ... ---)
    content = content.replace(/^---[\s\S]*?^---[\s]*?$/gm, '');
    // Clean up leading/trailing whitespace after frontmatter removal
    content = content.replace(/^[\s\n]+/, '');

    // 1. Convert wikilinks [[Page|alias]] → <a class="wikilink" data-target="Page">alias</a>
    //    and [[Page]] → <a class="wikilink" data-target="Page">Page</a>
    //    Cross-file anchors [[Seite#Anker]] → <a class="wikilink" data-target="Seite" data-anchor="#anker">Seite: Anker</a>
    content = content.replace(/\[\[([^\]]+)\]\]/g, function(match, inner) {
      // Unescape pipes from table escaping (\| → |)
      inner = inner.replace(/\\\|/g, '|');

      const pipeIndex = inner.indexOf('|');
      let target, alias;

      if (pipeIndex === -1) {
        target = inner;
        alias = null;
      } else {
        target = inner.substring(0, pipeIndex);
        alias = inner.substring(pipeIndex + 1);
      }

      // Cross-file anchor link: target contains # but does NOT start with #
      const anchorMatch = target.match(/^(.+)#(.+)$/);
      if (anchorMatch && !target.startsWith('#')) {
        const filePath = anchorMatch[1];
        const anchorRaw = anchorMatch[2];
        const anchorDisplay = anchorRaw.replace(/\s+/g, ' ');
        const displayName = alias || filePath + ': ' + anchorDisplay;
        const normalizedAnchor = '#' + anchorRaw.replace(/\s+/g, '-').toLowerCase();
        return '<a class="wikilink" data-target="' + escapeHtml(filePath) + '" data-anchor="' + escapeHtml(normalizedAnchor) + '">' + escapeHtml(displayName) + '</a>';
      }

      // Regular wikilink
      const displayName = alias || inner;
      return '<a class="wikilink" data-target="' + escapeHtml(target) + '">' + escapeHtml(displayName) + '</a>';
    });

    // 2. Convert tags #tagname → <span class="tag">#tagname</span>
    //    First protect # in <a>-tags (attrs + body) so they aren't detected as tags
    content = content.replace(/<a([^>]*)>([^<]*)<\/a>/g, function(match, attrs, body) {
      return '<a' + attrs.replace(/#/g, '\u00A3') + '>' + body.replace(/#/g, '\u00A3') + '</a>';
    });
    content = content.replace(/(?<![a-zA-Z0-9_#])#([a-zA-Z0-9_\u00C0-\u024F\u3040-\u30FF\u4E00-\u9FFF][a-zA-Z0-9_\u00C0-\u024F\u3040-\u30FF\u4E00-\u9FFF]*)/g,
      '<span class="tag">#$1</span>');
    // Stelle # in <a>-Tags wieder her
    content = content.replace(/<a([^>]*)>([^<]*)<\/a>/g, function(match, attrs, body) {
      return '<a' + attrs.replace(/\u00A3/g, '#') + '>' + body.replace(/\u00A3/g, '#') + '</a>';
    });

    // 3. Convert embed syntax ![[file.png]] to <img>
    content = content.replace(/!\[\[([^\]]+)\]\]/g, function(match, target) {
      return '<img class="embed" src="' + escapeHtml(target) + '">';
    });

    // 4. Convert block references [[Page^block]] → <span class="blockref">Page#block</span>
    content = content.replace(/\[\[([^\]]+)\^([a-zA-Z0-9_-]+)\]\]/g,
      '<span class="blockref" data-page="$1" data-block="$2">$1#$2</span>');

    // 5. Convert LaTeX $$...$$ → <span class="math">...</span>
    content = content.replace(/\$\$([^\$]+)\$\$/g, '<span class="math">$$ $1 $$</span>');

    // 6. Convert fenced code blocks ```lang\ncode\n``` → <pre><code>...</code></pre>
    content = content.replace(/```([^`\n]*)\n([\s\S]*?)```/g, function(match, lang, code) {
      return '<pre class="code-block" data-lang="' + escapeHtml(lang) + '"><code>' + escapeHtml(code) + '</code></pre>';
    });

    // 7. Convert Obsidian callouts > [!type] → <div class="callout">...</div>
    content = content.replace(/^> \[!([a-zA-Z0-9_-]+)\]([\s\S]*?)(?=^> \[!|$)/gm, function(match, type, body) {
      const calloutMap = {
        'note': '\uD83D\uDCDD', 'abstract': '\uD83D\uDCCB', 'info': '\u2139\uFE0F', 'todo': '\u2705',
        'tip': '\uD83D\uDCA1', 'success': '\u2714\uFE0F', 'question': '\u2753', 'warning': '\u26A0\uFE0F',
        'failure': '\u274C', 'danger': '\uD83D\uDEA5', 'bug': '\uD83D\uDC1B', 'example': '\uD83D\uDCDA',
        'quote': '\u201C'
      };
      const icon = calloutMap[type.toLowerCase()] || '\uD83D\uDCC4';
      return '<div class="callout callout-' + type.toLowerCase() + '">' +
        '<div class="callout-title">' + icon + ' <strong>' + type + '</strong></div>' +
        '<div class="callout-content">' + body.trim() + '</div></div>';
    });

    // ── Parse remaining Markdown with marked ──
    let html = marked.parse(content);

    // ── Post-process: fix callout divs that got wrapped in <p> ──
    html = html.replace(/<p class="callout[^"]*">/g, '<div class="callout">');

    // ── Post-process: add id attributes to headings ──
    html = html.replace(/<(h[1-6])>([^<]*)<\/h[1-6]>/g, function(match, tag, text) {
      // Decode HTML entities for the ID (marked encodes & to &amp; etc.)
      const decoded = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const id = decoded.trim().replace(/\s+/g, '-').toLowerCase();
      return '<' + tag + ' id="' + id + '">' + text + '</' + tag + '>';
    });

    return html;
  }

  // Pre-built name index for O(1) wikilink resolution
  let nameIndex = null;
  function buildNameIndex() {
    nameIndex = new Map(); // lowercase filename -> first path with that name
    for (const path of Object.keys(files)) {
      const fileName = path.split('/').pop().replace('.md', '').toLowerCase();
      if (!nameIndex.has(fileName)) {
        nameIndex.set(fileName, path);
      }
    }
  }

  function resolveWikilink(sourcePath, targetName) {
    // Try exact match
    if (files[targetName]) return targetName;
    // Try with .md extension
    if (files[targetName + '.md']) return targetName + '.md';

    // Use name index for fast lookup
    if (nameIndex) {
      const targetBase = targetName.replace(/\\/g, '/').toLowerCase();
      const resolved = nameIndex.get(targetBase);
      if (resolved) return resolved;
    }

    return null;
  }

  // ═══════════════════════════════════════
  //  Graph Building
  // ═══════════════════════════════════════

  function buildGraph() {
    const paths = Object.keys(files);

    // ── Parse tags from all files ──
    const tagToFileMap = new Map(); // tagName -> Set of file paths
    fileTagsMap = new Map();        // filePath -> Set of tag names (global)

    for (const path of paths) {
      const tagSet = parseTags(files[path]);
      fileTagsMap.set(path, tagSet);
      for (const tag of tagSet) {
        if (!tagToFileMap.has(tag)) tagToFileMap.set(tag, new Set());
        tagToFileMap.get(tag).add(path);
      }
    }

    // ── Create tag nodes ──
    const tagNames = Array.from(tagToFileMap.keys());
    for (let i = 0; i < tagNames.length; i++) {
      const tagName = tagNames[i];
      const fileCount = tagToFileMap.get(tagName).size;
      const tagNode = {
        id: 'tag:' + tagName,
        name: tagName,
        x: 0, y: 0, z: 0,
        color: TAG_COLORS[i % TAG_COLORS.length],
        fileCount: fileCount,
        radius: 0.5 + Math.min(fileCount * 0.15, 1.2)
      };
      tagNodes.push(tagNode);
    }

    // Create nodes
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const name = path.split('/').pop().replace('.md', '');
      const node = {
        id: path,
        path: path,
        name: name,
        x: 0, y: 0, z: 0,
        radius: 1.2 + Math.random() * 1.8,
        color: PLANET_COLORS[i % PLANET_COLORS.length],
        inDegree: 0,
        outDegree: 0,
        content: files[path]
      };
      nodes.push(node);
    }

    // Build name index for fast wikilink resolution (MUST be before resolveWikilink calls)
    buildNameIndex();

    // Create edges from wikilinks
    edges = [];
    const edgeSet = new Set();

    // Build node lookup map for O(1) access
    nodeMap = new Map();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    for (const path of paths) {
      const links = parseWikilinks(files[path]);
      for (const link of links) {
        const resolved = resolveWikilink(path, link);
        if (resolved && nodeMap.has(resolved)) {
          const key = path + '->' + resolved;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ source: path, target: resolved });
            const srcNode = nodeMap.get(path);
            const tgtNode = nodeMap.get(resolved);
            if (srcNode) srcNode.outDegree++;
            if (tgtNode) tgtNode.inDegree++;
          }
        }
      }
    }

    // ── Add tag-to-file edges ──
    const tagEdgeSet = new Set();
    for (const [path, tagSet] of fileTagsMap) {
      for (const tag of tagSet) {
        const tagId = 'tag:' + tag;
        const key = path + '->' + tagId;
        if (!tagEdgeSet.has(key)) {
          tagEdgeSet.add(key);
          edges.push({ source: path, target: tagId });
        }
      }
    }

    // Position nodes using force-directed layout
    positionNodes();

    // Update status
    statusFiles.textContent = 'Files: ' + nodes.length + ' | Tags: ' + tagNodes.length;
    statusLinks.textContent = 'Connections: ' + edges.length;
  }

  function positionNodes() {
    const fileCount = nodes.length;
    const tagCount = tagNodes.length;
    const totalCount = fileCount + tagCount;
    const spread = Math.max(25, Math.pow(totalCount, 0.42) * 6);

    // Initialize file node positions on a sphere
    for (let i = 0; i < fileCount; i++) {
      const phi = Math.acos(1 - 2 * (i + 0.5) / Math.max(1, fileCount));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      nodes[i].x = spread * Math.sin(phi) * Math.cos(theta);
      nodes[i].y = spread * Math.sin(phi) * Math.sin(theta);
      nodes[i].z = spread * Math.cos(phi);
    }

    // Initialize tag nodes at centroid, spread radially to prevent clustering
    for (let i = 0; i < tagCount; i++) {
      const tagId = 'tag:' + tagNodes[i].name;
      let cx = 0, cy = 0, cz = 0, count = 0;
      for (const edge of edges) {
        if (edge.target === tagId) {
          for (let j = 0; j < fileCount; j++) {
            if (nodes[j].id === edge.source) {
              cx += nodes[j].x; cy += nodes[j].y; cz += nodes[j].z;
              count++;
              break;
            }
          }
        }
      }
      if (count > 0) {
        cx /= count; cy /= count; cz /= count;
        const len = Math.sqrt(cx*cx + cy*cy + cz*cz) + 0.01;
        // Direction from center to centroid
        const dirX = cx / len;
        const dirY = cy / len;
        const dirZ = cz / len;
        // Find perpendicular direction for angular spread
        let perpX, perpY, perpZ;
        if (Math.abs(dirX) < 0.9) {
          perpX = dirY; perpY = -dirX; perpZ = 0;
        } else {
          perpX = 0; perpY = dirZ; perpZ = -dirY;
        }
        const pLen = Math.sqrt(perpX*perpX + perpY*perpY + perpZ*perpZ) + 0.01;
        const px = perpX / pLen, py = perpY / pLen, pz = perpZ / pLen;
        // Angular offset based on index
        const angle = (i / Math.max(1, tagCount)) * Math.PI * 2;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        // Rotate direction by angle around perpendicular axis
        const rx = dirX * cosA + px * sinA;
        const ry = dirY * cosA + py * sinA;
        const rz = dirZ * cosA + pz * sinA;
        const rLen = Math.sqrt(rx*rx + ry*ry + rz*rz) + 0.01;
        // Place tag at 1.5x the centroid distance, spread angularly
        tagNodes[i].x = (rx / rLen) * Math.max(len * 1.5, 8);
        tagNodes[i].y = (ry / rLen) * Math.max(len * 1.5, 8);
        tagNodes[i].z = (rz / rLen) * Math.max(len * 1.5, 8);
      } else {
        // Fallback: random near center
        tagNodes[i].x = (Math.random() - 0.5) * 5;
        tagNodes[i].y = (Math.random() - 0.5) * 5;
        tagNodes[i].z = (Math.random() - 0.5) * 5;
      }
    }

    // Force-directed layout iterations
    const iterations = 300;
    const k = spread * 0.55; // ideal distance
    const cooling = 0.97;
    let temperature = 8;

    for (let iter = 0; iter < iterations; iter++) {
      const fx = new Float64Array(totalCount);
      const fy = new Float64Array(totalCount);
      const fz = new Float64Array(totalCount);

      // Get all positions
      function getPos(i) {
        if (i < fileCount) return { x: nodes[i].x, y: nodes[i].y, z: nodes[i].z };
        const ti = i - fileCount;
        return { x: tagNodes[ti].x, y: tagNodes[ti].y, z: tagNodes[ti].z };
      }
      function setPos(i, p) {
        if (i < fileCount) { nodes[i].x = p.x; nodes[i].y = p.y; nodes[i].z = p.z; }
        else { const ti = i - fileCount; tagNodes[ti].x = p.x; tagNodes[ti].y = p.y; tagNodes[ti].z = p.z; }
      }

      // Repulsive forces (all pairs)
      for (let i = 0; i < totalCount; i++) {
        for (let j = i + 1; j < totalCount; j++) {
          const pi = getPos(i), pj = getPos(j);
          const dx = pj.x - pi.x;
          const dy = pj.y - pi.y;
          const dz = pj.z - pi.z;
          const distSq = dx * dx + dy * dy + dz * dz + 0.01;
          const dist = Math.sqrt(distSq);
          const force = (k * k) / distSq;
          const fxVal = (dx / dist) * force;
          const fyVal = (dy / dist) * force;
          const fzVal = (dz / dist) * force;
          fx[i] -= fxVal; fy[i] -= fyVal; fz[i] -= fzVal;
          fx[j] += fxVal; fy[j] += fyVal; fz[j] += fzVal;
        }
      }

      // Strong tag-tag repulsion: prevent all tags from clustering
      for (let i = 0; i < tagCount; i++) {
        for (let j = i + 1; j < tagCount; j++) {
          const ti = i + fileCount, tj = j + fileCount;
          const pi = getPos(ti), pj = getPos(tj);
          const dx = pj.x - pi.x;
          const dy = pj.y - pi.y;
          const dz = pj.z - pi.z;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) + 0.01;
          // Stronger repulsion for tags (they tend to cluster at centroids)
          const tagK = k * 0.3;
          const force = (tagK * tagK) / (dist * dist);
          const fxVal = (dx / dist) * force;
          const fyVal = (dy / dist) * force;
          const fzVal = (dz / dist) * force;
          fx[ti] -= fxVal; fy[ti] -= fyVal; fz[ti] -= fzVal;
          fx[tj] += fxVal; fy[tj] += fyVal; fz[tj] += fzVal;
        }
      }

      // Collision repulsion: prevent tag-file overlap based on radii
      for (let i = 0; i < fileCount; i++) {
        for (let j = 0; j < tagCount; j++) {
          const fi = i, tj = j + fileCount;
          const pi = getPos(fi), pt = getPos(tj);
          const dx = pi.x - pt.x;
          const dy = pi.y - pt.y;
          const dz = pi.z - pt.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
          const minDist = nodes[i].radius + tagNodes[j].radius + 2.0;
          if (dist < minDist) {
            const overlap = minDist - dist;
            const force = overlap * 0.8;
            const fxVal = (dx / dist) * force;
            const fyVal = (dy / dist) * force;
            const fzVal = (dz / dist) * force;
            fx[fi] += fxVal; fy[fi] += fyVal; fz[fi] += fzVal;
            fx[tj] -= fxVal; fy[tj] -= fyVal; fz[tj] -= fzVal;
          }
        }
      }

      // Collision repulsion: prevent planet-planet overlap
      for (let i = 0; i < fileCount; i++) {
        for (let j = i + 1; j < fileCount; j++) {
          const pi = getPos(i), pj = getPos(j);
          const dx = pj.x - pi.x;
          const dy = pj.y - pi.y;
          const dz = pj.z - pi.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
          const minDist = nodes[i].radius + nodes[j].radius + 1.5;
          if (dist < minDist) {
            const overlap = minDist - dist;
            const force = overlap * 0.6;
            const fxVal = (dx / dist) * force;
            const fyVal = (dy / dist) * force;
            const fzVal = (dz / dist) * force;
            fx[i] -= fxVal; fy[i] -= fyVal; fz[i] -= fzVal;
            fx[j] += fxVal; fy[j] += fyVal; fz[j] += fzVal;
          }
        }
      }

      // Attractive forces (edges)
      for (const edge of edges) {
        // Find source index
        const si = nodes.findIndex(n => n.id === edge.source);
        if (si === -1) continue;
        // Find target index (tag node)
        const tagIdx = tagNodes.findIndex(t => t.id === edge.target);
        if (tagIdx === -1) continue;
        const ti = tagIdx + fileCount;

        const ps = getPos(si), pt = getPos(ti);
        const dx = pt.x - ps.x;
        const dy = pt.y - ps.y;
        const dz = pt.z - ps.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;

        // Tag edges use shorter ideal distance to keep connected files closer
        const isTagEdge = edge.target.startsWith('tag:');
        const edgeK = isTagEdge ? k * 0.35 : k;
        // Spring force: proportional to deviation from ideal distance
        const force = (dist - edgeK) * 0.03;
        const fxVal = (dx / dist) * force;
        const fyVal = (dy / dist) * force;
        const fzVal = (dz / dist) * force;
        fx[si] += fxVal; fy[si] += fyVal; fz[si] += fzVal;
        fx[ti] -= fxVal; fy[ti] -= fyVal; fz[ti] -= fzVal;
      }

      // Apply forces with temperature cooling
      for (let i = 0; i < totalCount; i++) {
        const displacement = Math.sqrt(fx[i]*fx[i] + fy[i]*fy[i] + fz[i]*fz[i]);
        if (displacement > 0) {
          const step = Math.min(displacement, temperature) / displacement;
          const p = getPos(i);
          setPos(i, { x: p.x + fx[i] * step, y: p.y + fy[i] * step, z: p.z + fz[i] * step });
        }
      }

      temperature *= cooling;
    }

    // ── Post-processing: resolve remaining overlaps ──
    // Iteratively push overlapping nodes apart until no overlaps remain
    for (let pass = 0; pass < 50; pass++) {
      let maxOverlap = 0;
      let hadOverlap = false;

      // Check tag-file overlaps
      for (let i = 0; i < fileCount; i++) {
        for (let j = 0; j < tagCount; j++) {
          const dx = nodes[i].x - tagNodes[j].x;
          const dy = nodes[i].y - tagNodes[j].y;
          const dz = nodes[i].z - tagNodes[j].z;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) + 0.01;
          const minDist = nodes[i].radius + tagNodes[j].radius + 1.5;
          if (dist < minDist) {
            hadOverlap = true;
            const push = (minDist - dist) * 0.5 / dist;
            nodes[i].x += dx * push;
            nodes[i].y += dy * push;
            nodes[i].z += dz * push;
            tagNodes[j].x -= dx * push;
            tagNodes[j].y -= dy * push;
            tagNodes[j].z -= dz * push;
          }
        }
      }

      // Check planet-planet overlaps
      for (let i = 0; i < fileCount; i++) {
        for (let j = i + 1; j < fileCount; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const dz = nodes[j].z - nodes[i].z;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) + 0.01;
          const minDist = nodes[i].radius + nodes[j].radius + 1.0;
          if (dist < minDist) {
            hadOverlap = true;
            const push = (minDist - dist) * 0.5 / dist;
            nodes[i].x -= dx * push;
            nodes[i].y -= dy * push;
            nodes[i].z -= dz * push;
            nodes[j].x += dx * push;
            nodes[j].y += dy * push;
            nodes[j].z += dz * push;
          }
        }
      }

      // Check tag-tag overlaps
      for (let i = 0; i < tagCount; i++) {
        for (let j = i + 1; j < tagCount; j++) {
          const dx = tagNodes[j].x - tagNodes[i].x;
          const dy = tagNodes[j].y - tagNodes[i].y;
          const dz = tagNodes[j].z - tagNodes[i].z;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) + 0.01;
          const minDist = tagNodes[i].radius + tagNodes[j].radius + 1.0;
          if (dist < minDist) {
            hadOverlap = true;
            // Stronger push for tags to prevent clustering
            const push = (minDist - dist) * 0.8 / dist;
            tagNodes[i].x -= dx * push;
            tagNodes[i].y -= dy * push;
            tagNodes[i].z -= dz * push;
            tagNodes[j].x += dx * push;
            tagNodes[j].y += dy * push;
            tagNodes[j].z += dz * push;
          }
        }
      }

      if (!hadOverlap) break;
    }
  }

  function nodeMapById(id) {
    return nodeMap.get(id) || nodes.find(n => n.id === id) || tagNodes.find(n => n.id === id);
  }

  // ═══════════════════════════════════════
  //  Three.js Setup
  // ═══════════════════════════════════════

  function initThree() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a12);
    scene.fog = new THREE.FogExp2(0x0a0a12, 0.003);

    // Camera
    const aspect = (viewport.clientWidth || 800) / (viewport.clientHeight || 600);
    camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 3000);
    camera.position.set(cameraDefaultPos.x, cameraDefaultPos.y, cameraDefaultPos.z);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Compute size explicitly since clientWidth may be 0 after display:none
    const vw = viewport.clientWidth || viewport.offsetWidth || 800;
    const vh = viewport.clientHeight || viewport.offsetHeight || 600;
    renderer.setSize(vw, vh);
    renderer.domElement.id = 'renderer-canvas';
    // Remove old renderer canvas before inserting new one (prevents duplicates on reload)
    const oldCanvas = viewport.querySelector('#renderer-canvas');
    if (oldCanvas) viewport.removeChild(oldCanvas);
    // Insert canvas before minimap so minimap stays on top
    const minimapEl = document.getElementById('minimap');
    viewport.insertBefore(renderer.domElement, minimapEl);

    // Controls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.8;
    controls.minDistance = 5;
    controls.maxDistance = 500;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    };

    // Lights
    const ambient = new THREE.AmbientLight(0x334466, 1.2);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(20, 30, 20);
    scene.add(dirLight);

    const pointLight1 = new THREE.PointLight(0x00f0ff, 3.0, 150);
    pointLight1.position.set(-20, 10, -20);
    scene.add(pointLight1);

    const pointLight2 = new THREE.PointLight(0xff00aa, 2.0, 150);
    pointLight2.position.set(20, -10, 20);
    scene.add(pointLight2);

    const pointLight3 = new THREE.PointLight(0xb400ff, 1.5, 150);
    pointLight3.position.set(0, 20, 0);
    scene.add(pointLight3);

    // Starfield
    createStarfield();

    // Raycaster
    raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 1.5 };
    mouse = new THREE.Vector2();

    // Minimap
    minimapCtx = minimapCanvas.getContext('2d');
    minimapCanvas.width = 320;
    minimapCanvas.height = 240;

    // Events
    renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown);
    renderer.domElement.addEventListener('click', onCanvasClick);
    renderer.domElement.addEventListener('mousemove', onCanvasMouseMove);
    renderer.domElement.addEventListener('mousemove', onTagCanvasMouseMove);
    window.addEventListener('resize', onResize);

    // Start animation loop
    animate();
  }

  function createStarfield() {
    const count = 2000;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const r = 200 + Math.random() * 300;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);

      // Slight color variation
      const c = 0.3 + Math.random() * 0.7;
      colors[i * 3] = c * 0.8;
      colors[i * 3 + 1] = c * 0.85;
      colors[i * 3 + 2] = c;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      sizeAttenuation: true
    });

    const stars = new THREE.Points(geometry, material);
    scene.add(stars);
  }

  // ═══════════════════════════════════════
  //  Build 3D Scene
  // ═══════════════════════════════════════

  function buildScene() {
    // Clear old — dispose Three.js resources to prevent memory leaks
    for (const group of planetMeshes) {
      for (const child of group.children) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      }
      scene.remove(group);
    }
    for (const group of tagMeshes) {
      for (const child of group.children) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      }
      scene.remove(group);
    }
    for (const line of lineSegments) {
      if (line.geometry) line.geometry.dispose();
      if (line.material) line.material.dispose();
      scene.remove(line);
    }
    for (const s of tagLabelSprites) scene.remove(s);
    for (const s of planetLabelSprites) scene.remove(s);
    // Dispose sprite materials/textures
    for (const s of tagLabelSprites) {
      if (s.material && s.material.map) s.material.map.dispose();
      if (s.material) s.material.dispose();
    }
    for (const s of planetLabelSprites) {
      if (s.material && s.material.map) s.material.map.dispose();
      if (s.material) s.material.dispose();
    }
    planetMeshes = [];
    tagMeshes = [];
    lineSegments = [];
    tagLabelSprites = [];
    planetLabelSprites = [];

    // ═══════════════════════════════════════
    //  Create tag nodes (crystal prisms)
    // ═══════════════════════════════════════
    for (const tagNode of tagNodes) {
      const group = new THREE.Group();
      const color = new THREE.Color(tagNode.color);

      // Hexagonal prism (crystal shape)
      const prismGeo = new THREE.CylinderGeometry(
        tagNode.radius * 0.7, tagNode.radius * 0.7,
        tagNode.radius * 2.2, 6
      );
      const prismMat = new THREE.MeshPhongMaterial({
        color: color.clone().multiplyScalar(0.8),
        emissive: color.clone().multiplyScalar(0.6),
        specular: new THREE.Color(0xffffff),
        shininess: 100,
        transparent: true,
        opacity: 0.85,
        flatShading: true
      });
      const prism = new THREE.Mesh(prismGeo, prismMat);
      group.add(prism);

      // Top cap (pyramid)
      const capGeo = new THREE.ConeGeometry(tagNode.radius * 0.7, tagNode.radius * 0.8, 6);
      const capMat = new THREE.MeshPhongMaterial({
        color: color.clone().multiplyScalar(1.0),
        emissive: color.clone().multiplyScalar(0.8),
        specular: new THREE.Color(0xffffff),
        shininess: 120,
        transparent: true,
        opacity: 0.9,
        flatShading: true
      });
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.y = tagNode.radius * 1.5;
      group.add(cap);

      // Glow ring (larger, more prominent than planet rings)
      const ringGeo = new THREE.RingGeometry(tagNode.radius * 1.2, tagNode.radius * 1.8, 6);
      const ringMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.lookAt(camera.position);
      group.add(ring);

      // Atmosphere glow
      const glowGeo = new THREE.SphereGeometry(tagNode.radius * 2.0, 12, 8);
      const glowMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.06,
        side: THREE.BackSide
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      group.add(glow);

      // Point light
      const pLight = new THREE.PointLight(color, 1.0, tagNode.radius * 12);
      group.add(pLight);

      group.position.set(tagNode.x, tagNode.y, tagNode.z);
      group.userData = { tagId: tagNode.id, tagNode: tagNode };
      scene.add(group);
      tagMeshes.push(group);

      // 3D label sprite (canvas texture)
      const tagLabelSprite = createLabelSprite('#' + tagNode.name, '#' + color.getHexString(), 1.2);
      tagLabelSprite.position.set(tagNode.x, tagNode.y + 2.5, tagNode.z);
      tagLabelSprite.userData.targetPixelHeight = 28;
      tagLabelSprite.visible = showLabels && showTags;
      scene.add(tagLabelSprite);
      tagLabelSprites.push(tagLabelSprite);
    }

    // ═══════════════════════════════════════
    //  Create planets
    // ═══════════════════════════════════════
    for (const node of nodes) {
      const group = new THREE.Group();

      // Planet sphere
      const geo = new THREE.SphereGeometry(node.radius, 32, 24);
      const color = new THREE.Color(node.color);
      const mat = new THREE.MeshPhongMaterial({
        color: color.clone().multiplyScalar(0.6),
        emissive: color.clone().multiplyScalar(0.5),
        specular: new THREE.Color(0x8888aa),
        shininess: 60,
        transparent: true,
        opacity: 0.95
      });
      const mesh = new THREE.Mesh(geo, mat);
      group.add(mesh);

      // Glow ring
      const ringGeo = new THREE.RingGeometry(node.radius * 1.5, node.radius * 2.0, 48);
      const ringMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.lookAt(camera.position);
      group.add(ring);

      // Atmosphere glow
      const glowGeo = new THREE.SphereGeometry(node.radius * 1.8, 24, 16);
      const glowMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.1,
        side: THREE.BackSide
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      group.add(glow);

      // Point light for each planet
      const pLight = new THREE.PointLight(color, 0.8, node.radius * 10);
      group.add(pLight);

      group.position.set(node.x, node.y, node.z);
      group.userData = { nodeId: node.id, node: node };
      scene.add(group);
      planetMeshes.push(group);

      // 3D label sprite (canvas texture)
      const displayName = node.name.length > 30 ? node.name.substring(0, 28) + '…' : node.name;
      const planetLabelSprite = createLabelSprite(displayName, '#' + color.getHexString(), 1.0);
      planetLabelSprite.position.set(node.x, node.y + node.radius + 1.5, node.z);
      planetLabelSprite.userData.targetPixelHeight = 24;
      planetLabelSprite.visible = showLabels;
      scene.add(planetLabelSprite);
      planetLabelSprites.push(planetLabelSprite);
    }

    // Create connection lines
    if (showLines) {
      for (const edge of edges) {
        const isTagEdge = edge.target.startsWith('tag:');
        let srcPos, tgtPos, srcColor, tgtColor;

        if (isTagEdge) {
          // Tag edge: file -> tag
          const srcNode = nodes.find(n => n.id === edge.source);
          if (!srcNode) continue;
          const tgtNode = tagNodes.find(t => t.id === edge.target);
          if (!tgtNode) continue;
          srcPos = new THREE.Vector3(srcNode.x, srcNode.y, srcNode.z);
          tgtPos = new THREE.Vector3(tgtNode.x, tgtNode.y, tgtNode.z);
          srcColor = new THREE.Color(srcNode.color);
          tgtColor = new THREE.Color(tgtNode.color);
        } else {
          // Wikilink edge: file -> file
          const srcNode = nodes.find(n => n.id === edge.source);
          const tgtNode = nodes.find(n => n.id === edge.target);
          if (!srcNode || !tgtNode) continue;
          srcPos = new THREE.Vector3(srcNode.x, srcNode.y, srcNode.z);
          tgtPos = new THREE.Vector3(tgtNode.x, tgtNode.y, tgtNode.z);
          srcColor = new THREE.Color(srcNode.color);
          tgtColor = new THREE.Color(tgtNode.color);
        }

        const points = [];
        const start = srcPos.clone();
        const end = tgtPos.clone();
        const mid = start.clone().add(end).multiplyScalar(0.5);
        // Add slight arc
        const dir = end.clone().sub(start);
        const dist = dir.length();
        mid.y += dist * 0.15;

        const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
        const curvePoints = curve.getPoints(32);
        for (const pt of curvePoints) {
          points.push(pt);
        }

        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const colors = new Float32Array(points.length * 3);
        for (let i = 0; i < points.length; i++) {
          const t = i / (points.length - 1);
          const c = srcColor.clone().lerp(tgtColor, t);
          colors[i * 3] = c.r;
          colors[i * 3 + 1] = c.g;
          colors[i * 3 + 2] = c.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const mat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: isTagEdge ? 0.15 : 0.25
        });
        // Note: linewidth is ignored by WebGL
        const line = new THREE.Line(geo, mat);
        line.userData = { source: edge.source, target: edge.target, isTagEdge: isTagEdge };
        scene.add(line);
        lineSegments.push(line);
      }
    }

    // Update minimap
    drawMinimap();
  }

  // ── Helper: create a single connection line ──
  function createLine(edge, isTagEdge) {
    let srcNode, tgtNode;
    if (isTagEdge) {
      srcNode = nodes.find(n => n.id === edge.source);
      tgtNode = tagNodes.find(t => t.id === edge.target);
    } else {
      srcNode = nodes.find(n => n.id === edge.source);
      tgtNode = nodes.find(n => n.id === edge.target);
    }
    if (!srcNode || !tgtNode) return null;

    const start = new THREE.Vector3(srcNode.x, srcNode.y, srcNode.z);
    const end = new THREE.Vector3(tgtNode.x, tgtNode.y, tgtNode.z);
    const mid = start.clone().add(end).multiplyScalar(0.5);
    const dir = end.clone().sub(start);
    const dist = dir.length();
    mid.y += dist * 0.15;

    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const curvePoints = curve.getPoints(32);

    const geo = new THREE.BufferGeometry().setFromPoints(curvePoints);
    const srcColor = new THREE.Color(srcNode.color);
    const tgtColor = new THREE.Color(tgtNode.color);
    const colors = new Float32Array(curvePoints.length * 3);
    for (let i = 0; i < curvePoints.length; i++) {
      const t = i / (curvePoints.length - 1);
      const c = srcColor.clone().lerp(tgtColor, t);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: isTagEdge ? 0.15 : 0.25
    });
    const line = new THREE.Line(geo, mat);
    line.userData = { source: edge.source, target: edge.target, isTagEdge: isTagEdge };
    return line;
  }

  // ═══════════════════════════════════════
  //  Minimap
  // ═══════════════════════════════════════

  function drawMinimap() {
    const ctx = minimapCtx;
    const w = minimapCanvas.width;
    const h = minimapCanvas.height;
    ctx.clearRect(0, 0, w, h);

    if (nodes.length === 0) return;

    // Find bounds
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }

    const padding = 20;
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const scale = Math.min((w - padding * 2) / rangeX, (h - padding * 2) / rangeY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Draw edges
    ctx.lineWidth = 0.5;
    for (const edge of edges) {
      const src = nodeMapById(edge.source);
      const tgt = nodeMapById(edge.target);
      if (!src || !tgt) continue;
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.15)';
      ctx.beginPath();
      ctx.moveTo(w/2 + (src.x - cx) * scale, h/2 + (src.y - cy) * scale);
      ctx.lineTo(w/2 + (tgt.x - cx) * scale, h/2 + (tgt.y - cy) * scale);
      ctx.stroke();
    }

    // Draw nodes
    for (const n of nodes) {
      const px = w/2 + (n.x - cx) * scale;
      const py = h/2 + (n.y - cy) * scale;
      const r = Math.max(2, n.radius * scale * 0.5);
      const color = new THREE.Color(n.color);
      ctx.fillStyle = '#' + color.getHexString();
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw tag nodes (diamonds)
    for (const n of tagNodes) {
      const px = w/2 + (n.x - cx) * scale;
      const py = h/2 + (n.y - cy) * scale;
      const r = Math.max(3, n.radius * scale * 0.6);
      const color = new THREE.Color(n.color);
      ctx.fillStyle = '#' + color.getHexString();
      ctx.beginPath();
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r, py);
      ctx.lineTo(px, py + r);
      ctx.lineTo(px - r, py);
      ctx.closePath();
      ctx.fill();
      // Glow
      ctx.shadowColor = '#' + color.getHexString();
      ctx.shadowBlur = 4;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Draw camera viewport indicator
    const camPos = camera.position;
    const camX = w/2 + (camPos.x - cx) * scale;
    const camY = h/2 + (camPos.y - cy) * scale;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(camX - 6, camY - 4, 12, 8);
  }

  // ═══════════════════════════════════════
  //  Camera Focus
  // ═══════════════════════════════════════

  let focusTarget = null;
  let focusFinalCamPos = null;
  const FOCUS_DURATION = 600; // ms

  function focusOnNode(nodeId) {
    // Find the 3D position of the node
    let pos;
    const planetNode = nodes.find(n => n.id === nodeId);
    if (planetNode) {
      pos = new THREE.Vector3(planetNode.x, planetNode.y, planetNode.z);
    } else {
      const tagNode = tagNodes.find(n => n.id === nodeId);
      if (tagNode) {
        pos = new THREE.Vector3(tagNode.x, tagNode.y, tagNode.z);
      }
    }
    if (!pos) return;

    // Save current state
    focusTarget = pos.clone();

    // Calculate new camera position: offset from target in direction of current view
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    const dist = camera.position.distanceTo(controls.target);

    // Clamp distance to reasonable range (don't zoom too close/far)
    const clampedDist = Math.max(15, Math.min(300, dist));
    focusFinalCamPos = new THREE.Vector3().addVectors(pos, dir.clone().multiplyScalar(clampedDist));
  }

  function updateFocus(deltaTime) {
    if (!focusTarget) return;

    // Always compute delta from current camera position (not original)
    const camDelta = new THREE.Vector3().subVectors(focusFinalCamPos, camera.position);
    const targetDelta = new THREE.Vector3().subVectors(focusTarget, controls.target);

    // Move a fraction toward target each frame (exponential decay)
    const factor = 1 - Math.pow(0.001, deltaTime / FOCUS_DURATION);
    camera.position.addScaledVector(camDelta, factor);
    controls.target.addScaledVector(targetDelta, factor);
    controls.update();

    // Check if close enough
    if (camera.position.distanceTo(focusFinalCamPos) < 0.1) {
      camera.position.copy(focusFinalCamPos);
      controls.target.copy(focusTarget);
      focusTarget = null;
    }
  }

  // ═══════════════════════════════════════
  //  Interaction
  // ═══════════════════════════════════════

  function onCanvasPointerDown(event) {
    mouseDownPos.x = event.clientX;
    mouseDownPos.y = event.clientY;
    isMouseDragging = false;
    // Only track left button (button 0)
    if (event.button !== 0) {
      isMouseDragging = true; // ignore non-left buttons
    }
  }

  function onCanvasClick(event) {
    // Check if this was a drag: distance from pointerdown > 5px
    const dx = event.clientX - mouseDownPos.x;
    const dy = event.clientY - mouseDownPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 5) {
      // This was a drag, not a click — do NOT clear highlight
      return;
    }

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    // Check planet meshes
    const meshes = [];
    for (const group of planetMeshes) {
      for (const child of group.children) {
        if (child.isMesh) meshes.push(child);
      }
    }
    // Check tag meshes
    for (const group of tagMeshes) {
      for (const child of group.children) {
        if (child.isMesh) meshes.push(child);
      }
    }

    const intersects = raycaster.intersectObjects(meshes, false);
    if (intersects.length > 0) {
      let hitObj = intersects[0].object;
      // Walk up to find the group
      while (hitObj.parent && !hitObj.userData.nodeId && !hitObj.userData.tagId) {
        hitObj = hitObj.parent;
      }
      if (hitObj.userData && hitObj.userData.nodeId) {
        selectPlanet(hitObj.userData.nodeId);
        return;
      }
      if (hitObj.userData && hitObj.userData.tagId) {
        selectTag(hitObj.userData.tagId);
        return;
      }
    }
    // Clicked empty space — clear tag highlight
    clearHighlight();
  }

  function onCanvasMouseMove(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    const meshes = [];
    for (const group of planetMeshes) {
      for (const child of group.children) {
        if (child.isMesh) meshes.push(child);
      }
    }

    const intersects = raycaster.intersectObjects(meshes, false);

    if (intersects.length > 0) {
      let hitObj = intersects[0].object;
      while (hitObj.parent && !hitObj.userData.nodeId) {
        hitObj = hitObj.parent;
      }
      if (hitObj.userData && hitObj.userData.node) {
        const node = hitObj.userData.node;
        tooltip.style.display = 'block';
        tooltip.style.left = (event.clientX + 15) + 'px';
        tooltip.style.top = (event.clientY - 10) + 'px';
        tooltip.textContent = node.name + '\n[' + node.path + ']';
        viewport.style.cursor = 'pointer';
        return;
      }
    }

    tooltip.style.display = 'none';
    viewport.style.cursor = 'grab';
  }

  function onTagCanvasMouseMove(event) {
    if (!showTags) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    const meshes = [];
    for (const group of tagMeshes) {
      for (const child of group.children) {
        if (child.isMesh) meshes.push(child);
      }
    }

    const intersects = raycaster.intersectObjects(meshes, false);

    if (intersects.length > 0) {
      let hitObj = intersects[0].object;
      while (hitObj.parent && !hitObj.userData.tagId) {
        hitObj = hitObj.parent;
      }
      if (hitObj.userData && hitObj.userData.tagNode) {
        const tagNode = hitObj.userData.tagNode;
        tooltip.style.display = 'block';
        tooltip.style.left = (event.clientX + 15) + 'px';
        tooltip.style.top = (event.clientY - 10) + 'px';
        tooltip.textContent = '#' + tagNode.name + ' (' + tagNode.fileCount + ' files)';
        viewport.style.cursor = 'pointer';
        return;
      }
    }
  }

  function selectPlanet(nodeId) {
    // If same planet clicked, toggle off
    if (highlightedPlanetId === nodeId) {
      clearHighlight();
      return;
    }

    // Push new state to history
    pushNavEntry(nodeId, 'planet');

    selectedNode = nodeId;
    highlightedPlanetId = nodeId;
    highlightedTagId = null;
    highlightedTagId = null;
    highlightedLines = [];
    highlightedIds = new Set();

    const node = nodeMapById(nodeId);
    if (!node) return;

    // Reset all line opacities and colors
    for (const line of lineSegments) {
      if (line.material) {
        const isTagEdge = line.userData && line.userData.isTagEdge;
        line.material.opacity = isTagEdge ? 0.15 : 0.25;
        line.material.color.setHex(isTagEdge ? 0x888888 : 0xaaaaaa);
      }
    }

    // Reset all planet emissive
    for (const group of planetMeshes) {
      if (group.userData && group.userData.node) {
        const c = new THREE.Color(group.userData.node.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.15);
          }
        }
      }
    }

    // Reset tag emissive
    for (const group of tagMeshes) {
      if (group.userData && group.userData.tagNode) {
        const c = new THREE.Color(group.userData.tagNode.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.3);
          }
        }
      }
    }

    // Highlight selected planet
    for (const group of planetMeshes) {
      const isSel = group.userData.nodeId === nodeId;
      for (const child of group.children) {
        if (child.isMesh && child.material.emissive) {
          if (isSel) {
            child.material.emissive.setHex(0x555555);
          }
        }
      }
    }
    // Add selected planet to highlighted set for pulsing
    highlightedIds.add(nodeId);

    // Find connected edges and nodes
    const connectedIds = new Set();
    for (const edge of edges) {
      if (edge.source === nodeId) {
        connectedIds.add(edge.target);
      }
      if (edge.target === nodeId) {
        connectedIds.add(edge.source);
      }
    }

    // Highlight connected planets
    for (const group of planetMeshes) {
      const isConnected = connectedIds.has(group.userData.nodeId);
      if (isConnected) {
        highlightedIds.add(group.userData.nodeId);
        const c = new THREE.Color(group.userData.node.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.5);
          }
        }
      }
    }

    // Highlight connected tags
    for (const group of tagMeshes) {
      const isConnected = connectedIds.has(group.userData.tagId);
      if (isConnected) {
        highlightedIds.add(group.userData.tagId);
        const c = new THREE.Color(group.userData.tagNode.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.5);
          }
        }
      }
    }

    // Highlight connected lines (animated later in render loop)
    const planetColor = '#' + new THREE.Color(node.color).getHexString();
    for (const line of lineSegments) {
      const isTargetEdge = line.userData && line.userData.target === nodeId;
      const isSourceEdge = line.userData && line.userData.source === nodeId;
      if (isTargetEdge || isSourceEdge) {
        highlightedLines.push(line);
        line.material.opacity = isTargetEdge ? 1.0 : 0.7;
        line.material.color.set(planetColor);
      }
    }

    // Load content
    loadFileContent(node.path);

    // Focus camera on selected planet
    focusOnNode(nodeId);
  }

  function clearHighlight() {
    highlightedTagId = null;
    highlightedPlanetId = null;
    highlightedLines = [];
    highlightedIds.clear();

    // Reset all line opacities
    for (const line of lineSegments) {
      if (line.material) {
        const isTagEdge = line.userData && line.userData.isTagEdge;
        line.material.opacity = isTagEdge ? 0.15 : 0.25;
        line.material.color.setHex(isTagEdge ? 0x888888 : 0xaaaaaa);
      }
    }

    // Reset all planet emissive
    for (const group of planetMeshes) {
      if (group.userData && group.userData.node) {
        const c = new THREE.Color(group.userData.node.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.15);
          }
        }
      }
    }

    // Reset tag emissive
    for (const group of tagMeshes) {
      if (group.userData && group.userData.tagNode) {
        const c = new THREE.Color(group.userData.tagNode.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.3);
          }
        }
      }
    }

    // Reset ring scales and opacities to base values (pulsing modifies these)
    for (const group of planetMeshes) {
      for (const child of group.children) {
        if (child.isMesh && child.geometry && child.geometry.type === 'RingGeometry') {
          child.scale.set(1, 1, 1);
          child.material.opacity = 0.25;
        }
      }
    }
    for (const group of tagMeshes) {
      for (const child of group.children) {
        if (child.isMesh && child.geometry && child.geometry.type === 'RingGeometry') {
          child.scale.set(1, 1, 1);
          child.material.opacity = 0.2;
        }
        if (child.isMesh && child.geometry && child.geometry.type === 'SphereGeometry') {
          // Atmosphere glow
          child.scale.set(1, 1, 1);
          child.material.opacity = 0.06;
        }
      }
    }
  }

  function selectTag(tagId) {
    // If same tag clicked, toggle off
    if (highlightedTagId === tagId) {
      clearHighlight();
      return;
    }

    // Push new state to history
    pushNavEntry(tagId, 'tag');

    const tagNode = tagNodes.find(t => t.id === tagId);
    if (!tagNode) return;

    highlightedTagId = tagId;
    highlightedLines = [];
    highlightedIds = new Set();

    // Reset all line opacities and colors
    for (const line of lineSegments) {
      if (line.material) {
        const isTagEdge = line.userData && line.userData.isTagEdge;
        line.material.opacity = isTagEdge ? 0.15 : 0.25;
        line.material.color.setHex(isTagEdge ? 0x888888 : 0xaaaaaa);
      }
    }

    // Reset all planet emissive
    for (const group of planetMeshes) {
      if (group.userData && group.userData.node) {
        const c = new THREE.Color(group.userData.node.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.15);
          }
        }
      }
    }

    // Reset tag emissive
    for (const group of tagMeshes) {
      if (group.userData && group.userData.tagNode) {
        const c = new THREE.Color(group.userData.tagNode.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.3);
          }
        }
      }
    }

    // Highlight selected tag node
    for (const group of tagMeshes) {
      const isSel = group.userData.tagId === tagId;
      for (const child of group.children) {
        if (child.isMesh && child.material.emissive) {
          if (isSel) {
            child.material.emissive.setHex(0x555555);
          }
        }
      }
    }
    // Add selected tag to highlighted set for pulsing
    highlightedIds.add(tagId);

    // Find connected edges and planets
    const connectedIds = new Set();
    for (const edge of edges) {
      if (edge.target === tagId) {
        connectedIds.add(edge.source);
      }
    }

    // Highlight connected planets
    for (const group of planetMeshes) {
      const isConnected = connectedIds.has(group.userData.nodeId);
      if (isConnected) {
        highlightedIds.add(group.userData.nodeId);
        const c = new THREE.Color(group.userData.node.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.5);
          }
        }
      }
    }

    // Highlight connected lines (animated later in render loop)
    for (const line of lineSegments) {
      const isTargetEdge = line.userData && line.userData.target === tagId;
      const isSourceEdge = line.userData && line.userData.source === tagId;
      if (isTargetEdge || isSourceEdge) {
        highlightedLines.push(line);
        // Bright tag color for maximum visibility
        line.material.opacity = isTargetEdge ? 1.0 : 0.7;
        line.material.color.set(tagNode.color);
      }
    }

    // Show files with this tag
    const filesWithTag = [];
    for (const [path, tagSet] of fileTagsMap) {
      if (tagSet.has(tagNode.name)) {
        filesWithTag.push(path);
      }
    }

    mdFilename.textContent = '#' + tagNode.name;
    const tagList = filesWithTag.map(f => '- [[' + f.split('/').pop().replace('.md', '') + ']]').join('\n');
    mdContent.innerHTML = renderMarkdown('**Tags:** #' + tagNode.name + '\n\n' +
      '**Files (' + filesWithTag.length + '):**\n' +
      '─'.repeat(40) + '\n' +
      tagList);
    attachWikilinkHandlers();

    // Focus camera on selected tag
    focusOnNode(tagId);
  }

  async function loadFileContent(path) {
    mdFilename.textContent = path;

    // Try cached content first
    if (files[path]) {
      mdContent.innerHTML = renderMarkdown(files[path]);
    } else {
      // Try reading from file system
      const content = await readFileContent(path);
      if (content !== null) {
        files[path] = content;
        mdContent.innerHTML = renderMarkdown(content);
      } else {
        mdContent.innerHTML = '<p style="color: var(--neon-magenta);">[File not found: ' + escapeHtml(path) + ']</p>';
      }
    }

    // Attach click handlers to wikilinks (always call)
    attachWikilinkHandlers();
  }

  function attachWikilinkHandlers() {
    // Remove old handlers to prevent accumulation
    const oldLinks = mdContent.querySelectorAll('.wikilink');
    for (const link of oldLinks) {
      link.replaceWith(link.cloneNode(true));
    }

    const links = mdContent.querySelectorAll('.wikilink');
    for (const link of links) {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const target = this.getAttribute('data-target');
        if (!target) return;

        // Check for cross-file anchor link (e.g. [[Seite#Anker]])
        const anchor = this.getAttribute('data-anchor');
        if (anchor && !target.startsWith('#')) {
          const resolvedPath = resolveWikilink(vaultPath, target);
          if (resolvedPath) {
            selectPlanet(resolvedPath);
            // Scroll after content is loaded
            setTimeout(() => {
              const heading = mdContent.querySelector(anchor);
              if (heading) {
                const rect = heading.getBoundingClientRect();
                const containerRect = mdContent.getBoundingClientRect();
                const top = rect.top - containerRect.top + mdContent.scrollTop;
                mdContent.scrollTop = top;
              }
            }, 150);
          }
          return;
        }

        // Anchor links (e.g. [[#Foobar]]) → scroll to heading
        if (target.startsWith('#')) {
          const normalized = '#' + target.slice(1).replace(/\s+/g, '-').toLowerCase();
          const heading = mdContent.querySelector(normalized);
          if (heading) {
            const rect = heading.getBoundingClientRect();
            const containerRect = mdContent.getBoundingClientRect();
            const top = rect.top - containerRect.top + mdContent.scrollTop;
            mdContent.scrollTop = top;
          }
          return;
        }

        // Resolve the target to a file path
        const resolvedPath = resolveWikilink(vaultPath, target);
        if (resolvedPath) {
          selectPlanet(resolvedPath);
        } else {
          // Try as tag
          const tagId = 'tag:' + target;
          const tagNode = tagNodes.find(t => t.id === tagId);
          if (tagNode) {
            selectTag(tagId);
          }
        }
      });
    }

    // Attach click handlers to tags
    const oldTags = mdContent.querySelectorAll('.tag');
    for (const tag of oldTags) {
      tag.replaceWith(tag.cloneNode(true));
    }

    const tags = mdContent.querySelectorAll('.tag');
    for (const tag of tags) {
      tag.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const tagName = this.textContent.replace('#', '');
        const tagId = 'tag:' + tagName;
        selectTag(tagId);
      });
    }
  }

  // ═══════════════════════════════════════
  //  UI
  // ═══════════════════════════════════════

  function showApp() {
    overlay.classList.add('hidden');
    app.style.display = 'flex';
    statusDot.classList.remove('offline');
    statusText.textContent = 'Vault loaded';

    // Initialize history with an overview state
    navHistory = [{ nodeId: null, type: 'overview' }];
    navHistoryIdx = 0;
    window.history.replaceState({ navIdx: 0 }, '', '');

    // Wait for layout to compute sizes (app was display:none)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!threeInitialized) {
          initThree();
          threeInitialized = true;
        } else {
          // Clean up old scene objects to prevent memory leaks
          for (const group of planetMeshes) {
            for (const child of group.children) {
              if (child.geometry) child.geometry.dispose();
              if (child.material) {
                if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                else child.material.dispose();
              }
            }
            scene.remove(group);
          }
          for (const line of lineSegments) {
            if (line.geometry) line.geometry.dispose();
            if (line.material) line.material.dispose();
            scene.remove(line);
          }
          planetMeshes = [];
          lineSegments = [];
          for (const s of planetLabelSprites) {
            if (s.material && s.material.map) s.material.map.dispose();
            if (s.material) s.material.dispose();
            scene.remove(s);
          }
          planetLabelSprites = [];
          for (const s of tagLabelSprites) {
            if (s.material && s.material.map) s.material.map.dispose();
            if (s.material) s.material.dispose();
            scene.remove(s);
          }
          tagLabelSprites = [];
        }
        buildScene();
      });
    });
  }

  function onResize() {
    const w = viewport.clientWidth || viewport.offsetWidth || 800;
    const h = viewport.clientHeight || viewport.offsetHeight || 600;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    drawMinimap();
  }

  // Resize handle (horizontal)
  (function initResize() {
    const handle = document.getElementById('resize-handle');
    let startX, startW;
    handle.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startW = mdPanel.offsetWidth;
      document.addEventListener('mousemove', onResizeMove);
      document.addEventListener('mouseup', onResizeEnd);
      e.preventDefault();
    });
    function onResizeMove(e) {
      const newViewportWidth = Math.max(100, Math.min(window.innerWidth - 250, e.clientX));
      viewport.style.width = newViewportWidth + 'px';
      mdPanel.style.width = (window.innerWidth - newViewportWidth - 6) + 'px';
      viewport.style.minWidth = '50px';
      drawMinimap();
    }
    function onResizeEnd() {
      document.removeEventListener('mousemove', onResizeMove);
      document.removeEventListener('mouseup', onResizeEnd);
      window.dispatchEvent(new Event('resize'));
    }
  })();

  // ═══════════════════════════════════════
  //  Navigation History
  // ═══════════════════════════════════════

  function pushNavEntry(nodeId, type) {
    if (isNavigatingHistory) return;
    // Truncate forward history
    navHistory = navHistory.slice(0, navHistoryIdx + 1);
    navHistory.push({ nodeId, type });
    navHistoryIdx++;
    window.history.pushState({ navIdx: navHistoryIdx }, '', '');
  }

  function navigateToEntry(idx) {
    const entry = navHistory[idx];
    if (!entry) return;
    if (entry.type === 'overview') {
      clearHighlight();
      return;
    }
    if (entry.type === 'planet') {
      selectPlanet(entry.nodeId);
    } else {
      selectTag(entry.nodeId);
    }
  }

  // Button handlers
  document.getElementById('btn-open-vault').addEventListener('click', openVault);

  const btnToggleLines = document.getElementById('btn-toggle-lines');
  btnToggleLines.classList.add('active');
  btnToggleLines.addEventListener('click', function() {
    showLines = !showLines;
    this.classList.toggle('active', showLines);
    if (showLines) {
      // Rebuild lines using the helper function
      for (const edge of edges) {
        const isTagEdge = edge.target.startsWith('tag:');
        const line = createLine(edge, isTagEdge);
        if (line) {
          scene.add(line);
          lineSegments.push(line);
        }
      }
    } else {
      for (const line of lineSegments) scene.remove(line);
      lineSegments = [];
    }
  });

  const btnToggleLabels = document.getElementById('btn-toggle-labels');
  btnToggleLabels.classList.add('active');
  btnToggleLabels.addEventListener('click', function() {
    showLabels = !showLabels;
    this.classList.toggle('active', showLabels);
    for (const sprite of planetLabelSprites) {
      sprite.visible = showLabels;
    }
    for (const sprite of tagLabelSprites) {
      sprite.visible = showLabels && showTags;
    }
  });

  // ── Tag toggle ──
  let showTags = true;
  const btnToggleTags = document.getElementById('btn-toggle-tags');
  btnToggleTags.classList.add('active');
  btnToggleTags.addEventListener('click', function() {
    showTags = !showTags;
    this.classList.toggle('active', showTags);
    for (const group of tagMeshes) {
      group.visible = showTags;
    }
    for (const sprite of tagLabelSprites) {
      sprite.visible = showTags && showLabels;
    }
  });

  // Smooth camera animation helper
  let cameraAnimId = null;
  function animateCamera(fromPos, toPos, fromTarget, toTarget, duration) {
    if (cameraAnimId) cancelAnimationFrame(cameraAnimId);
    const start = performance.now();
    function step(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      camera.position.set(
        fromPos.x + (toPos.x - fromPos.x) * ease,
        fromPos.y + (toPos.y - fromPos.y) * ease,
        fromPos.z + (toPos.z - fromPos.z) * ease
      );
      controls.target.set(
        fromTarget.x + (toTarget.x - fromTarget.x) * ease,
        fromTarget.y + (toTarget.y - fromTarget.y) * ease,
        fromTarget.z + (toTarget.z - fromTarget.z) * ease
      );
      controls.update();
      if (t < 1) {
        cameraAnimId = requestAnimationFrame(step);
      } else {
        cameraAnimId = null;
      }
    }
    cameraAnimId = requestAnimationFrame(step);
  }

  document.getElementById('btn-reset-view').addEventListener('click', function() {
    animateCamera(
      { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      cameraDefaultPos,
      { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      { x: 0, y: 0, z: 0 },
      800
    );
  });

  document.getElementById('btn-reload-vault').addEventListener('click', async function() {
    overlay.classList.remove('hidden');
    document.getElementById('loading-overlay').querySelector('.loader-text').textContent =
      'Vault is reloading...';
    // Reset all data structures before reloading
    files = {};
    nodes = [];
    tagNodes = [];
    edges = [];
    planetMeshes = [];
    tagMeshes = [];
    lineSegments = [];
    for (const s of planetLabelSprites) {
      if (s.material && s.material.map) s.material.map.dispose();
      if (s.material) s.material.dispose();
      scene.remove(s);
    }
    planetLabelSprites = [];
    for (const s of tagLabelSprites) {
      if (s.material && s.material.map) s.material.map.dispose();
      if (s.material) s.material.dispose();
      scene.remove(s);
    }
    tagLabelSprites = [];
    fileTagsMap = new Map();
    threeInitialized = false;
    selectedNode = null;
    clearHighlight();
    // Reset navigation history
    navHistory = [];
    navHistoryIdx = -1;
    await openVault();
  });

  document.getElementById('btn-close-md').addEventListener('click', function() {
    mdContent.textContent = '';
    mdFilename.textContent = '— No file selected —';
    selectedNode = null;
    clearHighlight();
    // Reset planet highlights
    for (const group of planetMeshes) {
      if (group.userData.node) {
        const c = new THREE.Color(group.userData.node.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.15);
          }
        }
      }
    }
    // Reset tag highlights
    for (const group of tagMeshes) {
      if (group.userData.tagNode) {
        const c = new THREE.Color(group.userData.tagNode.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            child.material.emissive.copy(c).multiplyScalar(0.3);
          }
        }
      }
    }
  });

  // ═══════════════════════════════════════
  //  Animation Loop
  // ═══════════════════════════════════════

  function animate() {
    requestAnimationFrame(animate);

    // Smooth camera focus
    const now = performance.now();
    const deltaTime = focusTarget ? (now - (animate._lastFocusTime || now)) : 0;
    animate._lastFocusTime = now;
    if (focusTarget) {
      updateFocus(deltaTime);
    }

    controls.update();

    // Rotate planets slowly
    const time = performance.now() * 0.001;
    for (const group of planetMeshes) {
      for (const child of group.children) {
        if (child.isMesh && child.geometry && child.geometry.type === 'SphereGeometry') {
          child.rotation.y += 0.002;
        }
        // Make ring face camera
        if (child.isMesh && child.geometry && child.geometry.type === 'RingGeometry') {
          child.lookAt(camera.position);
        }
      }
    }

    // Rotate tag crystals (faster, more dynamic)
    for (const group of tagMeshes) {
      for (const child of group.children) {
        if (child.isMesh && child.geometry && child.geometry.type === 'CylinderGeometry') {
          child.rotation.y += 0.005;
        }
        if (child.isMesh && child.geometry && child.geometry.type === 'RingGeometry') {
          child.lookAt(camera.position);
          child.rotation.z = Math.sin(time * 0.5) * 0.1;
        }
      }
    }

    // ── Highlight animation ──
    if (highlightedTagId !== null || highlightedPlanetId !== null) {
      const t = performance.now() * 0.001;

      // Determine highlight source color
      let highlightColor;
      if (highlightedTagId !== null) {
        const tagNode = tagNodes.find(n => n.id === highlightedTagId);
        if (tagNode) highlightColor = new THREE.Color(tagNode.color);
      } else if (highlightedPlanetId !== null) {
        const planetNode = nodes.find(n => n.id === highlightedPlanetId);
        if (planetNode) highlightColor = new THREE.Color(planetNode.color);
      }
      if (!highlightColor) highlightColor = new THREE.Color('#ffaa44');

      // Animate highlighted lines: gradient flow from highlight source to connected nodes
      for (const line of highlightedLines) {
        const positions = line.geometry.attributes.position;
        if (!positions) continue;
        const count = positions.count;
        const isTagEdge = line.userData && line.userData.isTagEdge;
        const targetId = isTagEdge ? line.userData.source : line.userData.target;
        // Find connected node color
        let flowColor;
        const sourcePlanet = nodes.find(n => n.id === targetId);
        if (sourcePlanet) {
          flowColor = new THREE.Color(sourcePlanet.color);
        } else {
          const tagNode = tagNodes.find(n => n.id === targetId);
          if (tagNode) {
            flowColor = new THREE.Color(tagNode.color);
          } else {
            flowColor = new THREE.Color('#ffaa44');
          }
        }

        // Pulsing opacity — keep it bright
        const pulse = 0.7 + 0.3 * Math.sin(t * 2.5 + highlightedLines.indexOf(line));
        line.material.opacity = isTagEdge ? Math.min(1.0, pulse) : Math.min(1.0, pulse * 0.85);

        // Animated gradient: flow from highlightColor to flowColor
        const colors = line.geometry.attributes.color;
        if (colors) {
          for (let i = 0; i < count; i++) {
            const baseT = i / (count - 1);
            // Animated offset for gradient flow
            const flowOffset = (t * 0.4) % 1.0;
            const localT = (baseT + flowOffset) % 1.0;
            const gradientT = Math.sin(localT * Math.PI); // smooth sine curve
            const c = highlightColor.clone().lerp(flowColor, gradientT);
            colors.setXYZ(i, c.r, c.g, c.b);
          }
          colors.needsUpdate = true;
        }
      }

      // Pulsing aura on highlighted planets — scale + opacity animation on rings
      for (const group of planetMeshes) {
        if (!highlightedIds.has(group.userData.nodeId)) continue;
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.0);
        const c = new THREE.Color(group.userData.node.color);
        for (const child of group.children) {
          if (child.isMesh && child.material.emissive) {
            // Boost emissive more aggressively
            child.material.emissive.copy(c).multiplyScalar(0.5 + pulse * 0.5);
          }
          // Scale ring for visible aura effect
          if (child.isMesh && child.geometry && child.geometry.type === 'RingGeometry') {
            const ringScale = 1.0 + pulse * 0.6;
            child.scale.set(ringScale, ringScale, ringScale);
            // Pulse ring opacity
            if (child.material.transparent) {
              child.material.opacity = 0.15 + pulse * 0.35;
            }
          }
        }
      }

      // Pulsing aura on highlighted tags — scale + opacity animation on rings
      for (const group of tagMeshes) {
        if (!highlightedIds.has(group.userData.tagId)) continue;
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.0);
        const c = new THREE.Color(group.userData.tagNode.color);
        for (const child of group.children) {
          // Scale ring for visible aura effect
          if (child.isMesh && child.geometry && child.geometry.type === 'RingGeometry') {
            const ringScale = 1.0 + pulse * 0.6;
            child.scale.set(ringScale, ringScale, ringScale);
            // Pulse ring opacity
            if (child.material.transparent) {
              child.material.opacity = 0.2 + pulse * 0.4;
            }
          }
          // Pulse atmosphere glow
          if (child.isMesh && child.geometry && child.geometry.type === 'SphereGeometry') {
            const glowScale = 1.0 + pulse * 0.3;
            child.scale.set(glowScale, glowScale, glowScale);
            if (child.material.transparent) {
              child.material.opacity = 0.06 + pulse * 0.1;
            }
          }
        }
      }
    }

    // Update label positions every frame — constant screen size
    if (showLabels) {
      const fovRad = camera.fov * Math.PI / 180;
      for (let i = 0; i < planetMeshes.length; i++) {
        const group = planetMeshes[i];
        const sprite = planetLabelSprites[i];
        if (!sprite) continue;

        const pos = new THREE.Vector3();
        group.getWorldPosition(pos);
        pos.y += group.userData.node.radius + 3.0;

        const projected = pos.clone().project(camera);
        sprite.visible = projected.z <= 1;
        if (sprite.visible) {
          sprite.position.copy(pos);
          const dist = camera.position.distanceTo(pos);
          const viewHeight = 2 * Math.tan(fovRad / 2) * dist;
          const s = sprite.userData.targetPixelHeight * viewHeight / renderer.domElement.clientHeight;
          const ar = sprite.userData.aspectRatio || 1;
          sprite.scale.set(s * ar, s, 1);
        }
      }

      for (let i = 0; i < tagMeshes.length; i++) {
        const group = tagMeshes[i];
        const sprite = tagLabelSprites[i];
        if (!sprite) continue;

        const pos = new THREE.Vector3();
        group.getWorldPosition(pos);
        pos.y += 4.0;

        const projected = pos.clone().project(camera);
        sprite.visible = projected.z <= 1;
        if (sprite.visible) {
          sprite.position.copy(pos);
          const dist = camera.position.distanceTo(pos);
          const viewHeight = 2 * Math.tan(fovRad / 2) * dist;
          const s = sprite.userData.targetPixelHeight * viewHeight / renderer.domElement.clientHeight;
          const ar = sprite.userData.aspectRatio || 1;
          sprite.scale.set(s * ar, s, 1);
        }
      }
    }

    // FPS counter
    frameCount++;
    const fpsNow = performance.now();
    if (fpsNow - lastFpsTime >= 1000) {
      statusFps.textContent = 'FPS: ' + frameCount;
      frameCount = 0;
      lastFpsTime = fpsNow;
    }

    // Update minimap every 30 frames
    if (frameCount % 30 === 0) {
      drawMinimap();
    }

    renderer.render(scene, camera);
  }

  // ═══════════════════════════════════════
  //  Label Sprite Helper
  // ═══════════════════════════════════════

  function createLabelSprite(text, colorHex, fontSize) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontSizeNum = fontSize * 30;
    ctx.font = 'bold ' + fontSizeNum + 'px monospace';
    const metrics = ctx.measureText(text);
    const padding = 24;
    canvas.width = Math.ceil(metrics.width) + padding * 2;
    canvas.height = Math.ceil(fontSizeNum * 1.6);

    ctx.font = 'bold ' + fontSizeNum + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.shadowColor = colorHex;
    ctx.shadowBlur = 12;
    ctx.fillStyle = colorHex;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    ctx.shadowBlur = 0;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(mat);
    // Proportional to canvas size (correct aspect ratio)
    sprite.scale.set(canvas.width / 40, canvas.height / 40, 1);
    sprite.userData.aspectRatio = canvas.width / canvas.height;
    return sprite;
  }

  // ═══════════════════════════════════════
  //  Init
  // ═══════════════════════════════════════

  // Auto-start: check browser support for webkitdirectory
  (function init() {
    const testInput = document.createElement('input');
    testInput.webkitdirectory = true;
    if (testInput.webkitdirectory !== true) {
      // No file system access support at all
      const loaderText = document.getElementById('loading-overlay').querySelector('.loader-text');
      loaderText.textContent = 'Browser not supported';
      document.getElementById('btn-open-vault').style.display = 'none';
      const fallback = document.createElement('div');
      fallback.style.cssText = 'font-size:11px; color: var(--neon-magenta); max-width: 400px; text-align: center; margin-top: 10px;';
      fallback.textContent = 'Please use a modern browser (Chrome, Edge, or Opera).';
      document.getElementById('loading-overlay').appendChild(fallback);
    }
  })();

  // ═══════════════════════════════════════
  //  Browser Back/Forward
  // ═══════════════════════════════════════

  window.addEventListener('popstate', function(e) {
    if (isNavigatingHistory) return;
    if (!e.state) return;

    // e.state.navIdx ist der Ziel-Index aus pushState
    const targetIdx = e.state.navIdx;
    if (targetIdx !== navHistoryIdx && targetIdx >= 0 && targetIdx < navHistory.length) {
      navHistoryIdx = targetIdx;
      isNavigatingHistory = true;
      navigateToEntry(targetIdx);
      isNavigatingHistory = false;
    }
  });

})();
