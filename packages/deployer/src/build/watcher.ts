import type { InputOptions, OutputOptions, Plugin } from 'rollup';
import { watch } from 'rollup';
import { getInputOptions as getBundlerInputOptions } from './bundler';
import { aliasHono } from './plugins/hono-alias';
import { nodeModulesExtensionResolver } from './plugins/node-modules-extension-resolver';
import { tsConfigPaths } from './plugins/tsconfig-paths';
import { bundleExternals } from './analyze';
import { noopLogger } from '@mastra/core/logger';
import { createWorkspacePackageMap } from '../bundler/workspaceDependencies';
import nodeResolve from '@rollup/plugin-node-resolve';
import * as resolve from "resolve.exports"
import { readFile, readFileSync } from 'node:fs';
import path from 'node:path';

export async function getInputOptions(
  entryFile: string,
  platform: 'node' | 'browser',
  env?: Record<string, string>,
  { sourcemap = false, transpilePackages = [] }: { sourcemap?: boolean; transpilePackages?: string[] } = {},
) {
  const dependencies = new Map<string, string>();
  const workspaceMap = await createWorkspacePackageMap();

  if (transpilePackages.length) {
    const { output, reverseVirtualReferenceMap } = await bundleExternals(
      new Map(
        transpilePackages.map(pkg => [pkg, { exports: ['*'], rootPath: null, isWorkspace: workspaceMap.has(pkg) }]),
      ),
      '.mastra/.build',
      noopLogger,
      {
        transpilePackages,
        isDev: true,
      },
    );

    for (const file of output) {
      if (file.type === 'asset') {
        continue;
      }

      if (file.isEntry && reverseVirtualReferenceMap.has(file.name)) {
        dependencies.set(reverseVirtualReferenceMap.get(file.name)!, file.fileName);
      }
    }
  }

  const inputOptions = await getBundlerInputOptions(
    entryFile,
    {
      dependencies,
      externalDependencies: new Set(),
      invalidChunks: new Set(),
      workspaceMap,
    },
    platform,
    env,
    { sourcemap },
  );

  if (Array.isArray(inputOptions.plugins)) {
    // filter out node-resolve plugin so all node_modules are external
    // and tsconfig-paths plugin as we are injection a custom one
    const plugins = [] as Plugin[];
    inputOptions.plugins.forEach(plugin => {
      if ((plugin as Plugin | undefined)?.name === 'node-resolve') {
        return;
      }

      if ((plugin as Plugin | undefined)?.name === 'tsconfig-paths') {
        plugins.push(
          tsConfigPaths({
            localResolve: true,
          }),
        );
        return;
      }

      plugins.push(plugin as Plugin);
    });

    inputOptions.plugins = plugins;
    inputOptions.plugins.push(aliasHono());
    inputOptions.plugins.push({
      name: 'stuff',
      resolveId(id: string, importer: string | undefined, options: any) {
        if (!workspaceMap.has(id)) {
          return
        }
        const pkgJson = workspaceMap.get(id)!
        const json = readFileSync(`${pkgJson.location}/package.json`, 'utf-8')
        const resolved = resolve.resolve(JSON.parse(json), id)
        // @ts-expect-error - todo
        const resolvedPath = path.join(pkgJson.location, 'node_modules/.cache', resolved[0].replace('.ts', '.js'))

        console.log({ resolved, pkgJson, resolvedPath })

        return {
          id: resolvedPath,
          external: true,
        }
      }
    });
    // fixes imports like lodash/fp/get
    inputOptions.plugins.push(nodeModulesExtensionResolver());
  }

  return inputOptions;
}

export async function createWatcher(inputOptions: InputOptions, outputOptions: OutputOptions) {
  const watcher = await watch({
    ...inputOptions,
    output: {
      ...outputOptions,
      format: 'esm',
      entryFileNames: '[name].mjs',
      chunkFileNames: '[name].mjs',
    },
  });

  return watcher;
}
