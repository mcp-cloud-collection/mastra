import type { Plugin } from 'rollup';
import type { WorkspacePackageInfo } from '../../bundler/workspaceDependencies';

export function relativeWorkspaceDeps(workspaceMap: Map<string, WorkspacePackageInfo>): Plugin {
  return {
    name: 'relative-workspace-deps',
    resolveId(id: string) {
      if (!workspaceMap.has(id)) {
        return;
      }
      console.log({ id });
    },
  } satisfies Plugin;
}
