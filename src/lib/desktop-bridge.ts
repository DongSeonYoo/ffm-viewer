export type DocumentKind = 'markdown' | 'json';

export interface DocumentPayload {
  readonly path: string;
  readonly name: string;
  readonly kind: DocumentKind;
  readonly content: string;
}

export type Dispose = () => void;
export type PathHandler = (path: string) => void;

export interface DesktopBridge {
  chooseDocument(): Promise<string | null>;
  readDocument(path: string): Promise<DocumentPayload>;
  watchDocument(
    path: string,
    onChange: PathHandler,
    onError: PathHandler,
  ): Promise<void>;
  takePendingOpen(): Promise<string | null>;
  onOpenRequested(handler: PathHandler): Promise<Dispose>;
  onFileDropped(handler: PathHandler): Promise<Dispose>;
  openExternal(url: string): Promise<void>;
  resolveLocalImage(documentPath: string, source: string): Promise<string | null>;
}
