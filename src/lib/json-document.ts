export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonKind =
  | 'array'
  | 'object'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null';

export interface JsonNode {
  readonly key?: string | number;
  readonly path: string;
  readonly kind: JsonKind;
  readonly value: JsonValue;
  readonly childCount: number;
  readonly children?: undefined;
}

export interface JsonChildPage {
  readonly items: JsonNode[];
  readonly hasMore: boolean;
  readonly nextOffset: number;
}

function kindOf(value: JsonValue): JsonKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  return 'boolean';
}

function createNode(
  value: JsonValue,
  path: string,
  key?: string | number,
): JsonNode {
  const kind = kindOf(value);
  const childCount = Array.isArray(value)
    ? value.length
    : kind === 'object'
      ? Object.keys(value as Record<string, JsonValue>).length
      : 0;

  return { key, path, kind, value, childCount };
}

export function parseJsonDocument(source: string): JsonNode {
  let value: JsonValue;
  try {
    value = JSON.parse(source) as JsonValue;
  } catch {
    throw new Error('Invalid JSON. Check the document syntax and try again.');
  }

  return createNode(value, '$');
}

export function toJsonPath(parentPath: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parentPath}.${key}`
    : `${parentPath}[${JSON.stringify(key)}]`;
}

export function getJsonChildren(
  node: JsonNode,
  offset: number,
  limit: number,
): JsonChildPage {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(1, limit);
  let items: JsonNode[] = [];

  if (node.kind === 'array') {
    const values = node.value as JsonValue[];
    items = values
      .slice(safeOffset, safeOffset + safeLimit)
      .map((value, index) => {
        const key = safeOffset + index;
        return createNode(value, `${node.path}[${key}]`, key);
      });
  } else if (node.kind === 'object') {
    const entries = Object.entries(node.value as Record<string, JsonValue>);
    items = entries
      .slice(safeOffset, safeOffset + safeLimit)
      .map(([key, value]) => createNode(value, toJsonPath(node.path, key), key));
  }

  const nextOffset = safeOffset + items.length;
  return {
    items,
    hasMore: nextOffset < node.childCount,
    nextOffset,
  };
}
