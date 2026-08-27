export type DocumentKind = 'markdown' | 'json' | 'text' | 'yaml' | 'toml' | 'image';

export interface DocumentPayload {
  readonly path: string;
  readonly name: string;
  readonly kind: DocumentKind;
  readonly content: string;
}

export type Dispose = () => void;
export type PathHandler = (path: string) => void;
export type CloseDecision = 'save' | 'discard' | 'cancel';

export interface DesktopBridge {
  chooseDocuments(): Promise<readonly string[]>;
  readDocument(path: string): Promise<DocumentPayload>;
  watchDocument(
    path: string,
    onChange: PathHandler,
    onError: PathHandler,
  ): Promise<void>;
  takePendingOpen(): Promise<readonly string[]>;
  onOpenRequested(handler: PathHandler): Promise<Dispose>;
  onFileDropped(handler: PathHandler): Promise<Dispose>;
  openExternal(url: string): Promise<void>;
  resolveLocalImage(documentPath: string, source: string): Promise<string | null>;
  confirmClose(name: string): Promise<CloseDecision>;
  saveDocument(
    baseName: string,
    kind: Exclude<DocumentKind, 'image'>,
    content: string,
  ): Promise<boolean>;
  onCloseRequested(handler: () => Promise<boolean>): Promise<Dispose>;
}
