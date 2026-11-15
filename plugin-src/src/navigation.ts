/** One bounded trail shared by repository and file panels. */
export class NavigationTrail<T> {
  private entries: T[] = [];
  private index = -1;
  private key: (entry: T) => string;
  private limit: number;
  constructor(key: (entry: T) => string, limit = 80) { this.key = key; this.limit = limit; }
  get current(): T | undefined { return this.entries[this.index]; }
  get state(): { back: boolean; forward: boolean } { return { back: this.index > 0, forward: this.index + 1 < this.entries.length }; }
  push(entry: T): void {
    if (this.current && this.key(this.current) === this.key(entry)) { this.entries[this.index] = entry; return; }
    this.entries.splice(this.index + 1);
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
  }
  back(): T | undefined { return this.state.back ? this.entries[--this.index] : undefined; }
  forward(): T | undefined { return this.state.forward ? this.entries[++this.index] : undefined; }
}
