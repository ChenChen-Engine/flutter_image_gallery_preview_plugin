import * as vscode from 'vscode';
import { GalleryAssetItem } from './shared/types';

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export interface StaticStringMatch {
  value: string;
  start: number;
  end: number;
}

export interface ResourceLinkMatch extends StaticStringMatch {
  item: GalleryAssetItem;
}

export class ResourceReferenceState {
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private index = buildResourceReferenceIndex([]);
  private items: GalleryAssetItem[] = [];
  private _enabled: boolean;

  readonly onDidChange = this.changedEmitter.event;

  constructor(enabled = false) {
    this._enabled = enabled;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this._enabled === enabled) return;
    this._enabled = enabled;
    this.changedEmitter.fire();
  }

  updateItems(items: GalleryAssetItem[]): void {
    this.items = items;
    this.index = buildResourceReferenceIndex(items);
    if (this._enabled) this.changedEmitter.fire();
  }

  find(value: string, currentPath: string): GalleryAssetItem | null {
    return resolveResourceReference(this.index, value, currentPath);
  }

  dispose(): void {
    this.changedEmitter.dispose();
    this.items = [];
    this.index.clear();
  }
}

export class ResourceDocumentLinkProvider implements vscode.DocumentLinkProvider {
  readonly onDidChangeDocumentLinks: vscode.Event<void>;

  constructor(private readonly references: ResourceReferenceState) {
    this.onDidChangeDocumentLinks = references.onDidChange;
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    if (!this.references.enabled || document.uri.scheme !== 'file') return [];

    const text = document.getText();
    if (text.length > MAX_DOCUMENT_BYTES) return [];

    return findResourceLinkMatches(text, this.references, document.uri.fsPath)
      .map((match) => {
        const range = new vscode.Range(document.positionAt(match.start), document.positionAt(match.end));
        const link = new vscode.DocumentLink(range, vscode.Uri.file(match.item.absPath));
        link.tooltip = `Open resource: ${match.item.absPath}`;
        return link;
      });
  }
}

export class ResourceDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly references: ResourceReferenceState) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | null {
    if (!this.references.enabled || document.uri.scheme !== 'file') return null;

    const text = document.getText();
    if (text.length > MAX_DOCUMENT_BYTES) return null;

    const offset = document.offsetAt(position);
    const match = findResourceLinkMatches(text, this.references, document.uri.fsPath)
      .find((candidate) => offset >= candidate.start && offset <= candidate.end);
    if (!match) return null;

    return new vscode.Location(vscode.Uri.file(match.item.absPath), new vscode.Position(0, 0));
  }
}

export function buildResourceReferenceIndex(items: GalleryAssetItem[]): Map<string, GalleryAssetItem[]> {
  const index = new Map<string, GalleryAssetItem[]>();
  for (const item of items) {
    for (const key of resourceReferenceKeys(item)) {
      const list = index.get(key) ?? [];
      list.push(item);
      index.set(key, list);
    }
  }
  for (const [key, list] of index) {
    index.set(key, [...list].sort(compareByPath));
  }
  return index;
}

export function resolveResourceReference(
  index: Map<string, GalleryAssetItem[]>,
  value: string,
  currentPath: string
): GalleryAssetItem | null {
  const candidates = index.get(normalizeReference(value));
  if (!candidates?.length) return null;
  const current = normalizePath(currentPath).toLowerCase();
  return [...candidates].sort((a, b) => compareByContext(a, b, current))[0] ?? null;
}

export function findStaticStringLiterals(text: string): StaticStringMatch[] {
  const matches: StaticStringMatch[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(text.length, i + 2);
      continue;
    }

    if (ch === '`') {
      i = skipTemplateString(text, i + 1);
      continue;
    }

    if (ch === '\'' || ch === '"') {
      const rawStart = isRawStringPrefix(text, i) ? i - 1 : i;
      const parsed = readQuotedString(text, i, ch);
      if (parsed) {
        if (!isConcatenatedString(text, rawStart, parsed.end + 1) && !parsed.value.includes('$')) {
          matches.push({ value: normalizeReference(parsed.value), start: i + 1, end: parsed.end });
        }
        i = parsed.end + 1;
        continue;
      }
    }

    i += 1;
  }

  return matches;
}

export function findResourceLinkMatches(
  text: string,
  references: ResourceReferenceState,
  currentPath: string
): ResourceLinkMatch[] {
  if (!references.enabled) return [];
  const result: ResourceLinkMatch[] = [];
  for (const literal of findStaticStringLiterals(text)) {
    const item = references.find(literal.value, currentPath);
    if (item) result.push({ ...literal, item });
  }
  return result;
}

function resourceReferenceKeys(item: GalleryAssetItem): string[] {
  const keys = new Set<string>();
  if (item.copyToken) keys.add(normalizeReference(item.copyToken));
  if (item.relPath) keys.add(normalizeReference(item.relPath));
  return [...keys].filter(Boolean);
}

function normalizeReference(value: string): string {
  return normalizePath(value).replace(/^\/+/, '');
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function compareByContext(a: GalleryAssetItem, b: GalleryAssetItem, currentPathLower: string): number {
  return contextScore(b, currentPathLower) - contextScore(a, currentPathLower) || compareByPath(a, b);
}

function contextScore(item: GalleryAssetItem, currentPathLower: string): number {
  const modulePath = normalizePath(item.modulePath || '').toLowerCase().replace(/\/+$/, '');
  const projectPath = normalizePath(item.projectPath || '').toLowerCase().replace(/\/+$/, '');
  let score = 0;
  if (modulePath && currentPathLower.startsWith(`${modulePath}/`)) score += 100;
  if (projectPath && currentPathLower.startsWith(`${projectPath}/`)) score += 50;
  if (item.isPrimaryModule) score += 10;
  if (item.isPrimaryProject) score += 5;
  return score;
}

function compareByPath(a: GalleryAssetItem, b: GalleryAssetItem): number {
  return normalizePath(a.absPath).localeCompare(normalizePath(b.absPath));
}

function isRawStringPrefix(text: string, quoteIndex: number): boolean {
  const prefix = text[quoteIndex - 1];
  if (prefix !== 'r' && prefix !== 'R') return false;
  const before = text[quoteIndex - 2];
  return before == null || !/[A-Za-z0-9_$]/.test(before);
}

function readQuotedString(text: string, quoteIndex: number, quote: string): { value: string; end: number } | null {
  let value = '';
  let i = quoteIndex + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) return { value, end: i };
    if (ch === '\\') {
      if (i + 1 >= text.length) return null;
      value += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') return null;
    value += ch;
    i += 1;
  }
  return null;
}

function skipTemplateString(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '`') return i + 1;
    i += 1;
  }
  return text.length;
}

function isConcatenatedString(text: string, tokenStart: number, tokenEnd: number): boolean {
  const before = previousNonWhitespace(text, tokenStart - 1);
  const after = nextNonWhitespace(text, tokenEnd);
  if (before === '+' || after === '+') return true;
  if (before === '\'' || before === '"' || before === '`') return true;
  if (after === '\'' || after === '"' || after === '`') return true;
  if ((after === 'r' || after === 'R') && (text[nextNonWhitespaceIndex(text, tokenEnd) + 1] === '\'' || text[nextNonWhitespaceIndex(text, tokenEnd) + 1] === '"')) {
    return true;
  }
  return false;
}

function previousNonWhitespace(text: string, index: number): string | null {
  for (let i = index; i >= 0; i -= 1) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return null;
}

function nextNonWhitespace(text: string, index: number): string | null {
  const nextIndex = nextNonWhitespaceIndex(text, index);
  return nextIndex >= 0 ? text[nextIndex] : null;
}

function nextNonWhitespaceIndex(text: string, index: number): number {
  for (let i = index; i < text.length; i += 1) {
    if (!/\s/.test(text[i])) return i;
  }
  return -1;
}
