// A deliberate violation, one hop further out: the module itself never names the credentials, and
// its innocent-looking helper is the one that reaches them. A rule that only read the entry file
// would pass this.
import { mintThroughHelper } from './helper-that-reaches-the-key'

export const mint = mintThroughHelper
