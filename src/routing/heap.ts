/**
 * A binary min-heap keyed by number. The search pops millions of states per route, so
 * keys and values sit in two flat arrays rather than one {key, value} object per entry:
 * the keys stay unboxed doubles, and a phone that kills the tab past a few hundred MB
 * does not pay for an object per queued state.
 *
 * Sifting moves a hole instead of swapping, which makes the same comparisons as a swap
 * would, so equal keys still pop in the same order and routes do not move.
 */
export class Heap<T> {
  private keys: number[] = [];
  private values: T[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, value: T) {
    const keys = this.keys,
      values = this.values;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }
  pop() {
    const keys = this.keys,
      values = this.values;
    if (!keys.length) return undefined;
    const result = { key: keys[0], value: values[0] },
      key = keys.pop()!,
      value = values.pop()!;
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1,
          right = left + 1;
        let smallest = i,
          smallestKey = key;
        if (left < n && keys[left] < smallestKey) {
          smallest = left;
          smallestKey = keys[left];
        }
        if (right < n && keys[right] < smallestKey) smallest = right;
        if (smallest === i) break;
        keys[i] = keys[smallest];
        values[i] = values[smallest];
        i = smallest;
      }
      keys[i] = key;
      values[i] = value;
    }
    return result;
  }
}
