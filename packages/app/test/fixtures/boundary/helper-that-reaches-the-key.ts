import { type AppIdentity, appJwt } from '../../../src/credentials'

export const mintThroughHelper = (identity: AppIdentity): string => appJwt({ identity })
