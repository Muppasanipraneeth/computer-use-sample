/* exported renderMarkdown */
// Minimal markdown for agent replies. Builds DOM nodes with textContent only: model text never becomes markup.

const MD_FENCE = /```([\w-]*)\n?([\s\S]*?)(?:```|$)/g;
const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const MD_LIST = /^(\s*)([-*•+]|\d+[.)])\s+(.*)$/;
// Code first so nothing inside backticks becomes a link or emphasis; links before emphasis so `*` in URLs survives.
const MD_INLINE =
  /(`[^`\n]+`)|\[([^\]\n]+)\]\(\s*([^\s)]+)\s*\)|(https?:\/\/[^\s<>()[\]"'`]+)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;
// Sentence punctuation after a bare URL ("see https://a.com/x.") belongs to the sentence, not the link.
const MD_URL_TAIL = /[.,;:!?)\]}'"]+$/;
// `#` is the reply's top level; the chat bubble is not a page, so headings start below h2.
const MD_HEADING_TAGS = ["h3", "h4", "h5"];

function mdWebUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function mdHost(url) {
  return url.hostname.replace(/^www\./, "");
}

function mdLink(parent, url, label) {
  const link = document.createElement("a");
  link.className = "md-link";
  link.href = url.href;
  // target=_blank routes a plain click through the main process's window-open handler, which opens the system browser.
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = url.href;
  link.textContent = label;
  parent.append(link);
}

function mdInline(parent, text) {
  let cursor = 0;
  for (const match of text.matchAll(MD_INLINE)) {
    if (match.index > cursor) parent.append(text.slice(cursor, match.index));
    const [token, code, label, target, bare, strong, em] = match;
    cursor = match.index + token.length;
    if (code) {
      const node = document.createElement("code");
      node.textContent = code.slice(1, -1);
      parent.append(node);
    } else if (label !== undefined) {
      const url = mdWebUrl(target);
      if (!url) {
        parent.append(label);
        continue;
      }
      const shown = label.trim();
      mdLink(parent, url, shown === target || shown === url.href ? mdHost(url) : shown);
    } else if (bare) {
      const tail = bare.match(MD_URL_TAIL)?.[0] ?? "";
      const href = bare.slice(0, bare.length - tail.length);
      const url = mdWebUrl(href);
      if (url) mdLink(parent, url, mdHost(url));
      else parent.append(href);
      if (tail) parent.append(tail);
    } else {
      const node = document.createElement(strong ? "strong" : "em");
      node.textContent = strong ? strong.slice(2, -2) : em.slice(1, -1);
      parent.append(node);
    }
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}

function mdListElement(marker) {
  const number = Number.parseInt(marker, 10);
  const list = document.createElement(Number.isNaN(number) ? "ul" : "ol");
  if (number > 1) list.start = number;
  return list;
}

function mdSameKind(list, marker) {
  return list && (list.tagName.toLowerCase() === "ol") === /^\d/.test(marker);
}

/** One block (text between blank lines) may mix headings, paragraphs and lists, so lines are classified one by one. */
function mdBlock(fragment, block) {
  let paragraph = null;
  let list = null;
  let item = null;
  let nested = null;
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const heading = line.match(MD_HEADING);
    if (heading) {
      paragraph = list = item = nested = null;
      const node = document.createElement(MD_HEADING_TAGS[Math.min(heading[1].length, MD_HEADING_TAGS.length) - 1]);
      mdInline(node, heading[2]);
      fragment.append(node);
      continue;
    }
    const entry = line.match(MD_LIST);
    if (entry) {
      paragraph = null;
      const [, indent, marker, body] = entry;
      const li = document.createElement("li");
      mdInline(li, body);
      // Two or more spaces (or a tab) nests under the previous top-level item; deeper levels flatten into that one.
      if (item && indent.replace(/\t/g, "  ").length >= 2) {
        if (!mdSameKind(nested, marker)) {
          nested = mdListElement(marker);
          item.append(nested);
        }
        nested.append(li);
        continue;
      }
      if (!mdSameKind(list, marker)) {
        list = mdListElement(marker);
        fragment.append(list);
      }
      list.append(li);
      item = li;
      nested = null;
      continue;
    }
    // An indented line under a list item continues that item rather than starting a paragraph.
    if (item && /^\s{2,}/.test(line)) {
      const target = nested?.lastChild ?? item;
      target.append(document.createElement("br"));
      mdInline(target, line.trim());
      continue;
    }
    list = item = nested = null;
    if (paragraph) paragraph.append(document.createElement("br"));
    else {
      paragraph = document.createElement("p");
      fragment.append(paragraph);
    }
    mdInline(paragraph, line.trim());
  }
}

function mdBlocks(fragment, text) {
  for (const block of text.split(/\n[ \t]*\n/)) mdBlock(fragment, block);
}

function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  const source = String(text ?? "");
  let cursor = 0;
  for (const match of source.matchAll(MD_FENCE)) {
    mdBlocks(fragment, source.slice(cursor, match.index));
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = match[2].replace(/\n$/, "");
    pre.append(code);
    fragment.append(pre);
    cursor = match.index + match[0].length;
  }
  mdBlocks(fragment, source.slice(cursor));
  return fragment;
}
