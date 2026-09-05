export interface SpaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  getBytes?(key: string): Uint8Array | null;
  setBytes?(key: string, value: Uint8Array): void;
  removeItem(key: string): void;
  /** Resolves after queued IndexedDB writes commit; rejects if any write failed. */
  whenIdle?(): Promise<void>;
}
