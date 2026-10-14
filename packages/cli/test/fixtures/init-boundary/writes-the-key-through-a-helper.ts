// This entry names no filesystem module at all; the helper it imports does. Only a walk of the
// import graph fails it, which is why the rule walks instead of reading one file.
import type { ConvertedApp } from '@review-agent/app'
import { append } from './helper-that-writes-a-file'

export const keepACopy = (app: ConvertedApp, path: string): void => {
  append(path, app.pem.reveal())
}
