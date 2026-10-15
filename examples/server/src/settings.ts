import { defaultDeploymentConfig, type DeploymentConfig } from '@review-agent/sdk'

/** This deployment's settings: one object, read by both halves of the process — the receiver reads
 *  `command`, `autoReview` and `allowMulti` to decide what a delivery means, and every review reads the
 *  rest — so the two can never disagree, which is a step the App deployment has to remember
 *  (docs/deploying.md, "change the runner's settings"). The built-in defaults: tier `basic`,
 *  `inline+summary`, inline comments from severity 5, a check run named `review-agent`, no gate.
 *  Every setting: docs/configuration.md. Change it here, for example:
 *
 *    const defaults = defaultDeploymentConfig()
 *    return { ...defaults, report: { ...defaults.report, failAtOrAbove: 9 } }
 */
export const deploymentSettings = (): DeploymentConfig => defaultDeploymentConfig()
