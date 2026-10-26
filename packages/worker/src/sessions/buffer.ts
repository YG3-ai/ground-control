/**
 * Bounded ring buffer with absolute byte offsets for reconnectable reads.
 */
export class OutputBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private startOffset = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(1, maxBytes);
  }

  get length(): number {
    return this.totalBytes;
  }

  get nextOffset(): number {
    return this.startOffset + this.totalBytes;
  }

  get oldestOffset(): number {
    return this.startOffset;
  }

  append(data: Buffer | string): void {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.totalBytes += buf.length;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const drop = this.chunks.shift()!;
      this.totalBytes -= drop.length;
      this.startOffset += drop.length;
    }
  }

  /**
   * Read up to `maxBytes` starting at absolute `offset`.
   * If offset < oldest, clamp and mark truncated.
   */
  read(
    offset: number | undefined,
    maxBytes: number,
  ): {
    text: string;
    start_offset: number;
    next_offset: number;
    truncated_before: boolean;
    exhausted: boolean;
  } {
    const cap = Math.min(Math.max(1, maxBytes), this.maxBytes);
    let start = offset ?? this.startOffset;
    let truncated_before = false;
    if (start < this.startOffset) {
      truncated_before = true;
      start = this.startOffset;
    }
    if (start > this.startOffset + this.totalBytes) {
      start = this.startOffset + this.totalBytes;
    }

    const joined = Buffer.concat(this.chunks);
    const rel = start - this.startOffset;
    const slice = joined.subarray(rel, rel + cap);
    const next = start + slice.length;
    return {
      text: slice.toString("utf8"),
      start_offset: start,
      next_offset: next,
      truncated_before,
      exhausted: next >= this.startOffset + this.totalBytes,
    };
  }
}
