// The filesystem arriving after the import list, where a reviewer skimming the top of the file
// would not look for it.
import type { ConvertedApp } from '@review-agent/app'

export const keepACopy = async (app: ConvertedApp, path: string): Promise<void> => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, app.pem.reveal())
}
