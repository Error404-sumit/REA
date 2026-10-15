/** Incremental signature only; AsarArtifactReader owns complete header validation. */
export class AsarSignature {
  readonly #fixed = Buffer.alloc(16);
  #fixedBytes = 0;
  #remaining = 0;
  #state: "pending" | "matched" | "absent" = "pending";

  get matched(): boolean {
    return this.#state === "matched";
  }

  write(chunk: Buffer): void {
    if (this.#state !== "pending") return;
    let offset = 0;
    if (this.#fixedBytes < 16) {
      const count = Math.min(16 - this.#fixedBytes, chunk.length);
      chunk.copy(this.#fixed, this.#fixedBytes, 0, count);
      this.#fixedBytes += count;
      offset = count;
      if (this.#fixedBytes < 16) return;
      const headerSize = this.#fixed.readUInt32LE(4);
      const payloadSize = this.#fixed.readUInt32LE(8);
      this.#remaining = this.#fixed.readUInt32LE(12);
      if (
        this.#fixed.readUInt32LE(0) !== 4 ||
        headerSize < 16 ||
        payloadSize !== headerSize - 4 ||
        this.#remaining < 2 ||
        this.#remaining > payloadSize - 4
      ) {
        this.#state = "absent";
        return;
      }
    }
    const end = Math.min(chunk.length, offset + this.#remaining);
    for (; offset < end; offset++) {
      const byte = chunk[offset];
      this.#remaining--;
      // RFC 8259 whitespace, not JavaScript's broader trim/\s character set.
      if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a)
        continue;
      this.#state = byte === 0x7b ? "matched" : "absent";
      return;
    }
    if (this.#remaining === 0) this.#state = "absent";
  }
}
