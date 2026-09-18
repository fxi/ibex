/**
 * A binary min-heap keyed by number. The search pops millions of states per route, so
 * this stays a flat array of {key, value} with no comparator indirection.
 */
export class Heap<T> {
  private a: { key: number; value: T }[] = [];
  get size() {
    return this.a.length;
  }
  push(key: number, value: T) {
    const a = this.a;
    let i = a.length;
    a.push({ key, value });
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].key <= a[i].key) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return undefined;
    const result = a[0],
      last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1,
          right = left + 1;
        let smallest = i;
        if (left < a.length && a[left].key < a[smallest].key) smallest = left;
        if (right < a.length && a[right].key < a[smallest].key)
          smallest = right;
        if (smallest === i) break;
        [a[smallest], a[i]] = [a[i], a[smallest]];
        i = smallest;
      }
    }
    return result;
  }
}
