export const sameOrigin = (a: string, b: string): boolean => new URL(a).origin === new URL(b).origin
