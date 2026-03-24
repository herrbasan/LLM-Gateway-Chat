/*! markdown-it-prism shim: exposes window.markdownitPrism from ESM/CJS package if bundled externally.
   In this project we vendor Prism core and use a tiny inline plugin to let markdown-it emit Prism classes.
   If you later add a real UMD build of markdown-it-prism, replace this file with that build and remove the shim. */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.markdownitPrism = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // Minimal plugin that mirrors markdown-it-prism defaults: add 'language-xxx' classes only.
  return function mdPrism(md, opts) {
    const fence = md.renderer.rules.fence || function(tokens, idx) {
      const token = tokens[idx];
      const info = (token.info || '').trim();
      const lang = info.split(/\s+/)[0];
      const cls = lang ? 'language-' + md.utils.escapeHtml(lang) : '';
      const content = token.content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return '<pre class="' + (cls ? ('language-' + md.utils.escapeHtml(lang)) : '') + '"><code class="' + cls + '">' + content + '</code></pre>\n';
    };
    md.renderer.rules.fence = fence;
  };
}));
