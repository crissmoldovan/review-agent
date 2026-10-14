export const sameBytes = (a: string, b: string): boolean =>
  a.length === b.length && Buffer.from(a).equals(Buffer.from(b))
