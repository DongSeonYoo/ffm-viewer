import {
  parse as parseLosslessJson,
  stringify as stringifyLosslessJson,
} from 'lossless-json';

function parseJson(source: string): unknown {
  try {
    return parseLosslessJson(source);
  } catch (error) {
    if (error instanceof RangeError) {
      try {
        return JSON.parse(source) as unknown;
      } catch {
        // Use the same user-facing error for either parser.
      }
    }
    throw new Error('Invalid JSON. Check the document syntax and try again.');
  }
}

export function formatJsonDocument(source: string): string {
  return stringifyLosslessJson(parseJson(source), null, 2) ?? '';
}
