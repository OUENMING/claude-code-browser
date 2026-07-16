(function() {
  if (globalThis.__ccAutoCapture) return;

  function generateMarkdown(maxChars = 50000) {
    const els = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,li,pre,code,blockquote,table,img,figure,figcaption,dl,dt,dd,details,summary,strong,em,ul,ol');
    let md = '';
    const seen = new Set();

    for (const el of els) {
      if (seen.has(el)) continue;

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

      const t = el.tagName.toLowerCase(), txt = el.textContent.trim();
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
        case 'a':
          if (el.href && !el.href.startsWith('javascript:')) md += `[${txt}](${el.href})\n`;
          break;
        case 'img':
          if ((el.complete && el.naturalWidth >= 50 && el.naturalHeight >= 50) || (el.dataset.src && el.naturalWidth > 0))
            md += `![${el.alt||'image'}](${el.src})\n`;
          break;
        case 'figure':
          seen.add(el);
          for (const c of el.querySelectorAll('*')) seen.add(c);
          const img = el.querySelector('img'), cap = el.querySelector('figcaption');
          if (img && (img.complete && img.naturalWidth >= 50 || img.naturalWidth > 0)) {
            md += `![${cap?.textContent?.trim() || img.alt || 'image'}](${img.src})\n`;
            if (cap) md += `*${cap.textContent.trim()}*\n\n`;
          }
          break;
        case 'strong': case 'b': md += `**${txt}** `; break;
        case 'em': case 'i': md += `*${txt}* `; break;
        case 'kbd': md += `\`${txt}\` `; break;
      }
      if (md.length > maxChars) { md = md.slice(0, maxChars) + '\n\n... (truncated)'; break; }
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
        if (c.nodeType === 3) t += c.textContent.trim();
        else if (c.tagName === 'A') t += `[${c.textContent.trim()}](${c.href})`;
        else if (['STRONG','B'].includes(c.tagName)) t += `**${c.textContent.trim()}**`;
        else if (['EM','I'].includes(c.tagName)) t += `*${c.textContent.trim()}*`;
        else if (c.tagName === 'CODE') t += `\`${c.textContent.trim()}\``;
        else if (c.tagName === 'UL') t += '\n' + convertList(c).split('\n').map(l => '  ' + l).join('\n');
        else if (c.tagName === 'OL') t += '\n' + convertList(c).split('\n').map(l => '  ' + l).join('\n');
        else if (!['UL','OL'].includes(c.tagName)) t += c.textContent?.trim() || '';
      }
      items.push(`${isO ? idx++ + '. ' : '- '}${t}`);
    }
    return items.join('\n');
  }

  function convertTable(el) {
    const rows = [], mr = 10, mc = 8;
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
