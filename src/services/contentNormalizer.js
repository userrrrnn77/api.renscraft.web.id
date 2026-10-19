// src/services/contentNormalizer.js

// Line breaks written as XML numeric entities (&#10; &#xA; &10; &xA;), tabs and
// CRs likewise. Only whitespace entities are decoded, so &amp; / &ldquo; in JSX
// stay untouched.
export function decodeWhitespaceEntities(content) {
  return String(content ?? "")
    .replace(/&#?x0*a;|&#?0*10;/gi, "\n")
    .replace(/&#?x0*d;|&#?0*13;/gi, "")
    .replace(/&#?x0*9;|&#?0*9;/gi, "\t");
}

// Fix double-escaped newlines/quotes from AI JSON string output
export function normalizeContent(content) {
  if (!content) return "";

  // Remove BOM if present
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  // Normalize \r\n to \n
  content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // The model (via JSON mode) sometimes writes line breaks as XML numeric
  // entities. Left alone they end up in source files as literal text, break the
  // build ("Unexpected token") and make every search/replace miss.
  content = decodeWhitespaceEntities(content);

  // This model sometimes leaks special tokens where a line break belongs, with a
  // full-width semicolon in front: `import React from 'react'；<|reserved_token_163661|>export ...`
  content = content.replace(/(；)?<\|reserved_token_\d+\|>/g, (_, semi) => (semi ? ";\n" : "\n"));

  const realNewlines = (content.match(/\n/g) || []).length;
  const literalBackslashN = (content.match(/\\n/g) || []).length;

  if (literalBackslashN > realNewlines) {
    // Triple-escaped first: \\\\n → \\n (leave as literal), then \\n → \n
    content = content
      .replace(/\\\\n/g, "%%PRESERVED_ESCAPED_N%%")
      .replace(/\\n/g, "\n")
      .replace(/%%PRESERVED_ESCAPED_N%%/g, "\\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "")
      .replace(/\\\\/g, "\\");
  }

  // Always clean up backslash-escaped quotes (e.g. className=\"relative\") in code.
  // This is safe because "contains escaped quotes" is always invalid syntax in JSX/React.
  content = content.replace(/(\w+)=\\"([^"]*?)\\"/g, '$1="$2"');

  return content;
}