import { App } from '@octokit/app';
import { Octokit } from '@octokit/core';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { retry } from '@octokit/plugin-retry';
import type { Logger } from '../util/logger.js';

const OctokitWithRest = Octokit.plugin(restEndpointMethods, retry);

type Options = ConstructorParameters<typeof App>[0] & { Octokit: typeof OctokitWithRest };

/** Installation-scoped Octokit type (has `.rest` + retry). */
export type InstallationOctokit = Awaited<ReturnType<App<Options>['getInstallationOctokit']>>;

/**
 * GitHub API surface used by the rest of the service. Abstracted so tests can
 * inject a fake implementation.
 */
export interface GitHubApi {
  getInstallationToken(installationId: number): Promise<string>;
  getOctokit(installationId: number): Promise<InstallationOctokit>;
}

export class RealGitHubApi implements GitHubApi {
  readonly app: App<Options>;

  constructor(appId: number, privateKey: string, log: Logger) {
    this.app = new App({
      appId,
      privateKey,
      Octokit: OctokitWithRest,
      log: log.child({ module: 'octokit-app' }) as never,
    });
  }

  async getInstallationToken(installationId: number): Promise<string> {
    const octokit = await this.app.getInstallationOctokit(installationId);
    const auth = (await octokit.auth({ type: 'installation' })) as { token: string };
    return auth.token;
  }

  getOctokit(installationId: number): Promise<InstallationOctokit> {
    return this.app.getInstallationOctokit(installationId);
  }
}
