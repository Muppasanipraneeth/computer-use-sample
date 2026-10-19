import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Just enough DOM for markdown.js. innerHTML throws so any regression to markup-from-text fails loudly.
class Node {
  constructor(tagName) {
    this.tagName = tagName;
    this.childNodes = [];
    this.attributes = {};
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }
  append(...children) {
    for (const child of children) this.childNodes.push(typeof child === "string" ? { text: child } : child);
  }
  set textContent(value) {
    this.childNodes = [{ text: String(value) }];
  }
  set innerHTML(_value) {
    throw new Error("markdown.js must not use innerHTML");
  }
}

for (const name of ["className", "href", "target", "rel", "title", "start"]) {
  Object.defineProperty(Node.prototype, name, {
    get() {
      return this.attributes[name];
    },
    set(value) {
      this.attributes[name] = value;
    },
  });
}

const context = vm.createContext({
  URL,
  document: {
    createElement: (tag) => new Node(tag.toUpperCase()),
    createDocumentFragment: () => new Node("#fragment"),
  },
});
vm.runInContext(readFileSync(new URL("../renderer/markdown.js", import.meta.url), "utf8"), context);

// Compact HTML-ish serialization: tags, the attributes that matter, and text.
function html(node) {
  if ("text" in node) return node.text;
  const inner = node.childNodes.map(html).join("");
  if (node.tagName === "#fragment") return inner;
  const tag = node.tagName.toLowerCase();
  const attrs = ["className", "href", "start"]
    .filter((name) => node.attributes[name] !== undefined)
    .map((name) => ` ${name === "className" ? "class" : name}="${node.attributes[name]}"`)
    .join("");
  return tag === "br" ? "<br>" : `<${tag}${attrs}>${inner}</${tag}>`;
}

const render = (text) => html(context.renderMarkdown(text));

test("a heading followed by list items splits into a heading and a list", () => {
  assert.equal(render("## Top stories\n- One\n- Two"), "<h4>Top stories</h4><ul><li>One</li><li>Two</li></ul>");
  assert.equal(render("Here you go:\n1. First\n2. Second\nThat's all."), "<p>Here you go:</p><ol><li>First</li><li>Second</li></ol><p>That's all.</p>");
  assert.equal(render("# A\n### B #"), "<h3>A</h3><h5>B</h5>");
  assert.equal(render("#hashtag\nline two"), "<p>#hashtag<br>line two</p>");
});

test("indented items nest one level and continuation lines stay in their item", () => {
  assert.equal(
    render("- Parent\n  - Child\n    - Grandchild\n- Next\n  more about next"),
    "<ul><li>Parent<ul><li>Child</li><li>Grandchild</li></ul></li><li>Next<br>more about next</li></ul>",
  );
  assert.equal(render("3. Third\n4. Fourth"), '<ol start="3"><li>Third</li><li>Fourth</li></ol>');
});

test("links render only for http(s) URLs, labelled by text or host", () => {
  assert.equal(
    render("Per [TechCrunch](https://techcrunch.com/x) and [https://www.example.com/a](https://www.example.com/a)."),
    '<p>Per <a class="md-link" href="https://techcrunch.com/x">TechCrunch</a> and <a class="md-link" href="https://www.example.com/a">example.com</a>.</p>',
  );
  assert.equal(
    render("See https://www.theverge.com/story), then (https://a.io/x)."),
    '<p>See <a class="md-link" href="https://www.theverge.com/story">theverge.com</a>), then (<a class="md-link" href="https://a.io/x">a.io</a>).</p>',
  );
  assert.equal(render("[click me](javascript:alert(1)) and file:///etc/passwd"), "<p>click me) and file:///etc/passwd</p>");
});

test("emphasis, code and fences keep working and code is never linked", () => {
  assert.equal(render("**bold** *em* `https://a.io`"), "<p><strong>bold</strong> <em>em</em> <code>https://a.io</code></p>");
  assert.equal(render("Run:\n```sh\necho [x](https://a.io)\n```\n- done"), "<p>Run:</p><pre><code>echo [x](https://a.io)</code></pre><ul><li>done</li></ul>");
});
