import { formatJsonDocument } from './json-document';

export interface PreparedPastedDocument {
  readonly kind: 'markdown' | 'json';
  readonly content: string;
  readonly hint?: 'yaml' | 'toml';
}

export const MAX_PASTED_DOCUMENT_BYTES = 50 * 1024 * 1024;

export function isPastedDocumentTooLarge(
  source: string,
  maxBytes = MAX_PASTED_DOCUMENT_BYTES,
): boolean {
  return source.length > maxBytes || new TextEncoder().encode(source).byteLength > maxBytes;
}

function structuredHint(source: string): 'yaml' | 'toml' | undefined {
  const lines = source.split(/\r?\n/);
  let tomlAssignments = 0;
  let tomlSections = 0;
  let yamlMappings = 0;
  for (const line of lines) {
    if (/^\s*[\w.-]+\s*=\s*.+$/.test(line)) tomlAssignments += 1;
    if (/^\s*\[\[?[\w.-]+\]?\]\s*$/.test(line)) tomlSections += 1;
    if (/^\s*[\w.-]+\s*:\s*.*$/.test(line)) yamlMappings += 1;
  }
  if (tomlAssignments >= 2 || (tomlSections >= 1 && tomlAssignments >= 1)) return 'toml';
  if (yamlMappings >= 2) return 'yaml';
  return undefined;
}

export function preparePastedDocument(source: string): PreparedPastedDocument {
  const content = source.replace(/^\uFEFF/, '');
  const candidate = content.trimStart();
  if (candidate.startsWith('{') || candidate.startsWith('[')) {
    try {
      const formattedJson = formatJsonDocument(candidate);
      return { kind: 'json', content: formattedJson };
    } catch {
      // Brackets are only a cheap hint; malformed JSON remains readable Markdown.
    }
  }
  const hint = structuredHint(content);
  return hint ? { kind: 'markdown', content, hint } : { kind: 'markdown', content };
}
