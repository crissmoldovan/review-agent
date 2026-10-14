// A deliberate violation that no top-of-file import statement would show: the edge is a dynamic
// `import()` in the middle of a function, which is how a module that "doesn't import credentials"
// still ends up holding one. The identity is spelled out inline rather than imported as a type, so
// that this one edge is the ONLY thing the rule can be catching here.
export const mintLazily = async (identity: { clientId: string; privateKeyPem: string }): Promise<string> => {
  const credentials = await import('../../../src/credentials')
  return credentials.appJwt({ identity })
}
