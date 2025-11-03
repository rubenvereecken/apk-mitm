import { unzip, zip } from '@tybys/cross-zip'
import * as fs from './utils/fs'
import * as path from 'path'
import * as os from 'os'
import globby = require('globby')
import Listr = require('listr')
import execa = require('execa')

import patchApk from './patch-apk'
import { TaskOptions } from './cli'
import observeAsync from './utils/observe-async'
import buildGlob from './utils/build-glob'

export function patchXapkBundle(options: TaskOptions) {
  return patchAppBundle(options, { isXapk: true })
}

export function patchApksBundle(options: TaskOptions) {
  return patchAppBundle(options, { isXapk: false })
}

async function findApkPaths(bundleDir: string): Promise<string[]> {
  // Try to use manifest.json if available
  const manifestPath = path.join(bundleDir, 'manifest.json')
  const manifestExists = await fs.exists(manifestPath)

  if (manifestExists) {
    const manifestContent = await fs.readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(manifestContent)
    return getXapkApkPaths(bundleDir, manifest)
  }

  // No manifest: find all top-level APK files
  const apkFiles = await globby(buildGlob(bundleDir, '*.apk'))
  return apkFiles.sort()
}

function patchAppBundle(options: TaskOptions, { isXapk }: { isXapk: boolean }) {
  const { inputPath, outputPath, tmpDir, uberApkSigner } = options

  const bundleDir = path.join(tmpDir, 'bundle')
  let apkPaths: string[] = []

  return new Listr([
    {
      title: 'Validating bundle directory exists',
      enabled: () => options.recompileOnly,
      task: async () => {
        const exists = await fs.exists(bundleDir)
        if (!exists) {
          throw new Error(
            `Cannot use --recompile-only: bundle directory does not exist at ${bundleDir}. ` +
              `Run with --decompile-only first, or specify the same --tmp-dir used in the previous run.`,
          )
        }
      },
    },
    {
      title: 'Extracting APKs',
      skip: () => options.recompileOnly,
      task: async () => {
        await unzip(inputPath, bundleDir)

        if (os.type() !== 'Windows_NT') {
          // Under Unix: Make sure the user has read and write permissions to
          // the extracted files (which is sometimes not the case by default)
          await execa('chmod', ['-R', 'u+rw', bundleDir])
        }
      },
    },
    {
      title: 'Finding APKs to patch',
      task: async () => {
        apkPaths = await findApkPaths(bundleDir)

        if (apkPaths.length === 0) {
          throw new Error(`No APK files found in bundle at ${bundleDir}`)
        }
      },
    },
    {
      title: 'Patching APKs',
      // Contains both decompile and recompile steps -> always run
      skip: () => false,
      task: () =>
        new Listr(
          apkPaths.map(apkPath => {
            const apkName = path.basename(apkPath, '.apk')
            return {
              title: `Patching ${path.basename(apkPath)}`,
              task: () =>
                patchApk({
                  ...options,
                  inputPath: apkPath,
                  outputPath: apkPath,
                  tmpDir: path.join(tmpDir, apkName),
                }),
            }
          }),
          { concurrent: false },
        ),
    },
    {
      title: 'Signing APKs',
      skip: () => options.decompileOnly,
      task: () =>
        observeAsync(async log => {
          const apkFiles = await globby(buildGlob(bundleDir, '**/*.apk'))

          await uberApkSigner
            .sign(apkFiles, { zipalign: false })
            .forEach(line => log(line))
        }),
    },
    {
      title: 'Compressing APKs',
      skip: () => options.decompileOnly,
      task: () => zip(bundleDir, outputPath),
    },
  ])
}

function getXapkApkPaths(bundleDir: string, manifest: any): string[] {
  if (manifest.split_apks && Array.isArray(manifest.split_apks)) {
    // Extract all APK file names from split_apks array
    return manifest.split_apks
      .map((apk: any) => path.join(bundleDir, apk.file))
      .sort()
  }

  // Legacy format: single APK named after package
  if (manifest.package_name) {
    return [path.join(bundleDir, `${manifest.package_name}.apk`)]
  }

  // Fallback: empty array (will be caught by validation)
  return []
}
