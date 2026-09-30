// Shiki theme for docs code blocks. Every colour is a CSS variable (defined in styles/docs.css for light and dark),
// so one highlighted HTML serves both themes and the block sits on the neutral --panel surface.
const v = (name) => `var(--code-${name})`;

export const codeTheme = {
  name: "revenuedot-neutral",
  type: "light",
  colors: { "editor.foreground": v("fg"), "editor.background": "var(--panel)" },
  settings: [
    { settings: { foreground: v("fg"), background: "var(--panel)" } },
    { scope: ["comment", "punctuation.definition.comment", "string.comment"], settings: { foreground: v("comment"), fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.operator.new", "keyword.control", "variable.language"], settings: { foreground: v("keyword") } },
    { scope: ["string", "string.quoted", "string.template", "markup.inline.raw", "string.unquoted"], settings: { foreground: v("string") } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "support.constant", "constant.other"], settings: { foreground: v("constant") } },
    { scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function", "entity.name.command"], settings: { foreground: v("function") } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class"], settings: { foreground: v("type") } },
    { scope: ["support.type.property-name", "meta.object-literal.key", "entity.name.tag", "entity.other.attribute-name", "variable.other.property"], settings: { foreground: v("property") } },
    { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: v("punct") } },
    { scope: ["markup.inserted", "meta.diff.header.to-file", "punctuation.definition.inserted"], settings: { foreground: v("inserted") } },
    { scope: ["markup.deleted", "meta.diff.header.from-file", "punctuation.definition.deleted"], settings: { foreground: v("deleted") } },
    { scope: ["meta.diff.range", "meta.diff.header"], settings: { foreground: v("comment") } },
  ],
};
