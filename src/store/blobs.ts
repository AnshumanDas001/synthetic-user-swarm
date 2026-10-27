// Content-addressed blob store. Keys look like `study/session/step/<sha256>.<ext>` so the layout
// matches the spec's object-storage scheme; swapping in S3/R2/MinIO only means re-implementing put/get.
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { sha256 } from "../util/common.js";

export interface BlobStore {
  put(prefix: string, data: Buffer | string, ext: string): string;
  get(key: string): Buffer;
  path(key: string): string;
  exists(key: string): boolean;
}

export class LocalBlobStore implements BlobStore {
  constructor(private root = path.join(config.dataDir, "blobs")) {
    fs.mkdirSync(root, { recursive: true });
  }

  put(prefix: string, data: Buffer | string, ext: string): string {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    const key = `${prefix.replace(/\/+$/, "")}/${sha256(buf)}.${ext}`;
    const file = this.path(key);
    // Immutable: identical content maps to the same key and is never rewritten.
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    }
    return key;
  }

  get(key: string): Buffer {
    return fs.readFileSync(this.path(key));
  }

  path(key: string): string {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root))) throw new Error(`blob key escapes store: ${key}`);
    return resolved;
  }

  exists(key: string): boolean {
    return fs.existsSync(this.path(key));
  }
}
