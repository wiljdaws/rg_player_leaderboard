import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal DOM stub: highlightSuggestion only needs createTextNode and
// createElement. We keep it tiny so a real jsdom dep isn't required.
class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this.nodeName = "#text";
    this.textContent = String(text);
    this.childNodes = [];
    this.tagName = null;
  }
}

class ElementNode {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.childNodes = [];
    this._textContent = "";
  }
  set textContent(value) {
    this._textContent = String(value);
    this.childNodes = [new TextNode(value)];
  }
  get textContent() {
    return this.childNodes.map((child) =>
      child.nodeType === 3 ? child.textContent : child.textContent,
    ).join("");
  }
}

globalThis.document = {
  createTextNode: (text) => new TextNode(text),
  createElement: (tag) => new ElementNode(tag),
};

const { highlightSuggestion } = await import("../js/render.js");

function combinedText(nodes) {
  return nodes.map((n) => n.textContent).join("");
}

function tagNames(nodes) {
  return nodes.map((n) => n.tagName);
}

test("highlightSuggestion wraps the matched needle in a <mark> node", () => {
  const nodes = highlightSuggestion("HelloWorld", "world");
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].nodeType, 3);
  assert.equal(nodes[0].textContent, "Hello");
  assert.equal(nodes[1].nodeType, 1);
  assert.equal(nodes[1].tagName, "MARK");
  assert.equal(nodes[1].textContent, "World");
});

test("highlightSuggestion returns the whole name as a text node when needle is empty", () => {
  const nodes = highlightSuggestion("Anything", "");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].nodeType, 3);
  assert.equal(nodes[0].textContent, "Anything");
});

test("highlightSuggestion returns the whole name as a text node when needle is not found", () => {
  const nodes = highlightSuggestion("HelloWorld", "xyz");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].nodeType, 3);
  assert.equal(nodes[0].textContent, "HelloWorld");
});

test("highlightSuggestion escapes HTML in the name (XSS regression)", () => {
  // The red-team payload: a 22-char string that satisfies the alphanumeric
  // + emoji-block checks in the name field. Before the fix, this reached
  // `innerHTML` on the suggestion <li> and executed. Now the browser only
  // sees text nodes.
  const payload = "a<img src=x onerror=1>";
  const nodes = highlightSuggestion(payload, "a");
  assert.equal(combinedText(nodes), payload);
  // No <img> element should appear anywhere in the returned nodes — only
  // the <mark> wrapper for the matched "a" is allowed.
  const tags = tagNames(nodes).filter(Boolean);
  assert.deepEqual(tags, ["MARK"]);
  // Sanity: no child of any node should be an <img> either.
  for (const node of nodes) {
    for (const child of node.childNodes || []) {
      assert.notEqual(child.tagName, "IMG");
    }
  }
});

test("highlightSuggestion escapes HTML when the match spans the payload", () => {
  const payload = "<script>alert(1)</script>";
  const nodes = highlightSuggestion(payload, "script");
  assert.equal(combinedText(nodes), payload);
  const tags = tagNames(nodes).filter(Boolean);
  assert.deepEqual(tags, ["MARK"]);
});

test("highlightSuggestion coerces non-string names safely", () => {
  const nodes = highlightSuggestion(undefined, "");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].textContent, "");
});
