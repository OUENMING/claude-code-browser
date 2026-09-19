(function() {
  if (globalThis.__ccAutoCapture) return;

  // Containers whose own text is emitted wholesale. Their inline descendants
  // must be marked seen, or the main loop revisits each <a>/<strong>/<em>/<code>
  // and writes the same words a second time.
  const INLINE_HOSTS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote']);
  const INLINE_SEL = 'a,strong,b,em,i,code,img';

  // Smaller than this and the element is decoration, not content (see the
  // get_page_markdown description). Was an inline 50/50 in two places.
  const IMG_MIN_PX = 50;

  const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  const SAFE_SCHEME = /^(https?|mailto|tel|ftp):/i;

  // Only http/https/mailto/tel/ftp and scheme-less (relative) URLs go into the
  // Markdown. A `startsWith('javascript:')` test is not enough — case, leading
  // whitespace and embedded newlines (`java\nscript:`) all slip past it.
  function safeHref(href) {
    const raw = String(href || '').trim();
    const compact = raw.replace(/[\s\u0000-\u001f]+/g, '');
    if (!compact) return '';
    if (!HAS_SCHEME.test(compact)) return raw;
    return SAFE_SCHEME.test(compact) ? raw : '';
  }

  // The same text with inline elements rendered as markdown, so marking them
  // seen does not silently drop link and image URLs. Mirrors convertList.
  function inlineText(el) {
    let out = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType !== 1) continue;
      else if (n.tagName === 'A') { const h = safeHref(n.href); out += h ? `[${n.textContent.trim()}](${h})` : n.textContent; }
      else if (n.tagName === 'IMG') { const s = safeHref(n.dataset?.src || n.src); if (n.alt && s) out += `![${n.alt}](${s})`; }
      else if (['STRONG', 'B'].includes(n.tagName)) out += `**${n.textContent.trim()}**`;
      else if (['EM', 'I'].includes(n.tagName)) out += `*${n.textContent.trim()}*`;
      else if (n.tagName === 'CODE') out += `\`${n.textContent.trim()}\``;
      else out += n.textContent || '';
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function generateMarkdown(maxChars = 50000) {
    const els = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,li,pre,code,blockquote,table,img,figure,figcaption,dl,dt,dd,details,summary,strong,em,b,i,kbd,ul,ol');
    let md = '';
    const seen = new Set();

    for (const el of els) {
      if (seen.has(el)) continue;
      // Checked at the top, not the bottom: UL/OL/TABLE/DL/DETAILS all `continue`,
      // so a check after the switch never ran for them and long lists and tables
      // escaped the bound entirely.
      if (md.length > maxChars) { md = md.slice(0, maxChars) + '\n\n... (truncated)'; break; }

      if (['UL','OL'].includes(el.tagName)) {
        seen.add(el);
        for (const c of el.querySelectorAll('li,a,strong,em,code')) seen.add(c);
        md += convertList(el) + '\n\n';
        continue;
      }
      if (el.tagName === 'TABLE') {
        seen.add(el);
        for (const c of el.querySelectorAll('*')) seen.add(c);
        md += convertTable(el) + '\n\n';
        continue;
      }
      if (el.tagName === 'DL') {
        seen.add(el);
        for (const c of el.querySelectorAll('dt,dd')) seen.add(c);
        md += convertDL(el) + '\n\n';
        continue;
      }
      if (el.tagName === 'DETAILS') {
        seen.add(el);
        for (const c of el.querySelectorAll('*')) seen.add(c);
        const s = el.querySelector('summary');
        md += `> **${s?.textContent.trim() || 'Details'}**\n> ${el.textContent.replace(s?.textContent||'','').trim()}\n\n`;
        continue;
      }
      seen.add(el);

      const t = el.tagName.toLowerCase();
      let txt = el.textContent.trim();
      if (t === 'pre') {
        // A fenced block keeps its literal text, so only suppress its descendants.
        for (const c of el.querySelectorAll('*')) seen.add(c);
      } else if (INLINE_HOSTS.has(t)) {
        for (const c of el.querySelectorAll(INLINE_SEL)) seen.add(c);
        txt = inlineText(el);
      }
      switch (t) {
        case 'h1': md += `# ${txt}\n\n`; break;
        case 'h2': md += `## ${txt}\n\n`; break;
        case 'h3': md += `### ${txt}\n\n`; break;
        case 'h4': md += `#### ${txt}\n\n`; break;
        case 'h5': case 'h6': md += `##### ${txt}\n\n`; break;
        case 'p': md += `${txt}\n\n`; break;
        case 'blockquote': md += `> ${txt}\n\n`; break;
        case 'pre': md += `\`\`\`\n${txt}\n\`\`\`\n\n`; break;
        case 'code':
          if (el.parentElement?.tagName !== 'PRE') md += `\`${txt}\` `;
          break;
        case 'a': {
          const h = safeHref(el.href);
          if (h) md += `[${txt}](${h})\n`;
          break;
        }
        case 'img': {
          // A lazy-loaded image carries its real address in data-src until the
          // browser swaps it in; at that moment `el.src` is still the placeholder,
          // so writing it puts a 1×1 gif into the Markdown.
          const src = safeHref(el.dataset.src || el.src);
          const bigEnough = !!el.dataset.src
            || (el.complete && el.naturalWidth >= IMG_MIN_PX && el.naturalHeight >= IMG_MIN_PX);
          if (src && bigEnough) md += `![${el.alt || 'image'}](${src})\n`;
          break;
        }
        case 'figure': {
          seen.add(el);
          for (const c of el.querySelectorAll('*')) seen.add(c);
          const img = el.querySelector('img'), cap = el.querySelector('figcaption');
          const src = img && safeHref(img.dataset?.src || img.src);
          if (src && (!!img.dataset?.src || (img.complete && img.naturalWidth >= IMG_MIN_PX))) {
            md += `![${cap?.textContent?.trim() || img.alt || 'image'}](${src})\n`;
            if (cap) md += `*${cap.textContent.trim()}*\n\n`;
          }
          break;
        }
        case 'strong': case 'b': md += `**${txt}** `; break;
        case 'em': case 'i': md += `*${txt}* `; break;
        case 'kbd': md += `\`${txt}\` `; break;
      }
    }
    return md.trim() || '(no structured content — try get_page_text)';
  }

  function convertList(el) {
    const isO = el.tagName === 'OL';
    let idx = 1;
    const items = [];
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      let t = '';
      for (const c of li.childNodes) {
        // Comments have no tagName and used to fall through to the catch-all,
        // writing the comment body into the Markdown.
        if (c.nodeType === 8) continue;
        // Text nodes keep their spacing — trimming each one glued neighbouring
        // words together ("foo" + " " + "bar" came out as "foobar").
        if (c.nodeType === 3) { t += c.textContent.replace(/\s+/g, ' '); continue; }
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'A') {
          const h = safeHref(c.href);
          t += h ? `[${c.textContent.trim()}](${h})` : c.textContent.trim();
        }
        else if (['STRONG','B'].includes(c.tagName)) t += `**${c.textContent.trim()}**`;
        else if (['EM','I'].includes(c.tagName)) t += `*${c.textContent.trim()}*`;
        else if (c.tagName === 'CODE') t += `\`${c.textContent.trim()}\``;
        else if (['UL','OL'].includes(c.tagName)) t += '\n' + convertList(c).split('\n').map(l => '  ' + l).join('\n');
        else t += (c.textContent || '').replace(/\s+/g, ' ');
      }
      items.push(`${isO ? idx++ + '. ' : '- '}${t.replace(/\s+/g, ' ').trim()}`);
    }
    return items.join('\n');
  }

  // Table clipping is by shape, not by the character budget, so these are
  // deliberately independent of max_chars: a wide table rendered in full swamps
  // the output however high the budget is.
  const MAX_TABLE_ROWS = 10;
  const MAX_TABLE_COLS = 8;

  function convertTable(el) {
    const rows = [], mr = MAX_TABLE_ROWS, mc = MAX_TABLE_COLS;
    for (let i = 0; i < Math.min(el.rows.length, mr); i++) {
      const cells = [];
      for (let j = 0; j < Math.min(el.rows[i].cells.length, mc); j++)
        cells.push(el.rows[i].cells[j].textContent.trim().replace(/\|/g,'\\|').replace(/\n/g,' '));
      rows.push(`| ${cells.join(' | ')} |`);
      if (i === 0) rows.push(`| ${cells.map(()=>'---').join(' | ')} |`);
    }
    return rows.join('\n');
  }

  function convertDL(el) {
    const lines = [];
    for (const c of el.children) {
      if (c.tagName === 'DT') lines.push(`- **${c.textContent.trim()}**`);
      else if (c.tagName === 'DD') lines.push(`  ${c.textContent.trim()}`);
    }
    return lines.join('\n');
  }

  globalThis.__ccAutoCapture = { generateMarkdown };
})();
