/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import {Config, ProjectConfig} from '@react-native-community/cli-types';
import {
  logger,
  CLIError,
  link,
  startServerInNewWindow,
  findDevServerPort,
  cacheManager,
} from '@react-native-community/cli-tools';
import findXcodeProject from '../../config/findXcodeProject';
import getArchitecture from '../../tools/getArchitecture';
import getSimulators from '../../tools/getSimulators';
import listDevices from '../../tools/listDevices';
import resolvePods, {getPackageJson} from '../../tools/pods';
import {promptForDeviceSelection} from '../../tools/prompts';
import {BuildFlags} from '../buildCommand/buildOptions';
import {buildProject} from '../buildCommand/buildProject';
import {getConfiguration} from '../buildCommand/getConfiguration';
import {getXcodeProjectAndDir} from '../buildCommand/getXcodeProjectAndDir';
import {getFallbackSimulator} from './getFallbackSimulator';
import getPlatformReadableName from './getPlatformReadableName';
import getSDKNamefromPlatform from './getSDKNameFromPlatform';
import {printFoundDevices, matchingDevice} from './matchingDevice';
import {runOnDevice} from './runOnDevice';
import {runOnSimulator} from './runOnSimulator';
import {BuilderCommand} from '../../types';

export interface FlagsT extends BuildFlags {
  simulator?: string;
  device?: string | true;
  udid?: string;
  binaryPath?: string;
  listDevices?: boolean;
  packager?: boolean;
  port: number;
  terminal?: string;
}

const createRun =
  ({platformName}: BuilderCommand) =>
  async (_: Array<string>, ctx: Config, args: FlagsT) => {
    // React Native docs assume platform is always ios/android
    link.setPlatform('ios');
    const platform = ctx.project[platformName] as ProjectConfig['ios'];
    const platformReadableName = getPlatformReadableName(platformName);

    if (platform === undefined) {
      throw new CLIError(
        `Unable to find ${platformReadableName} platform config`,
      );
    }

    let {packager, port} = args;
    let installedPods = false;
    // check if pods need to be installed
    if (platform?.automaticPodsInstallation || args.forcePods) {
      const isAppRunningNewArchitecture = platform?.sourceDir
        ? await getArchitecture(platform?.sourceDir)
        : undefined;

      await resolvePods(ctx.root, ctx.dependencies, {
        forceInstall: args.forcePods,
        newArchEnabled: isAppRunningNewArchitecture,
      });

      installedPods = true;
    }

    const fallbackSimulator = getFallbackSimulator(args);

    if (packager) {
      const {port: newPort, startPackager} = await findDevServerPort(
        port,
        ctx.root,
      );

      if (startPackager) {
        await startServerInNewWindow(
          newPort,
          ctx.root,
          ctx.reactNativePath,
          args.terminal,
        );
      }
    }

    if (ctx.reactNativeVersion !== 'unknown') {
      link.setVersion(ctx.reactNativeVersion);
    }

    let {xcodeProject, sourceDir} = getXcodeProjectAndDir(platform);

    // if project is freshly created, revisit Xcode project to verify Pods are installed correctly.
    // This is needed because ctx project is created before Pods are installed, so it might have outdated information.
    if (installedPods) {
      const recheckXcodeProject = findXcodeProject(fs.readdirSync(sourceDir));
      if (recheckXcodeProject) {
        xcodeProject = recheckXcodeProject;
      }
    }

    process.chdir(sourceDir);

    if (args.binaryPath) {
      args.binaryPath = path.isAbsolute(args.binaryPath)
        ? args.binaryPath
        : path.join(ctx.root, args.binaryPath);

      if (!fs.existsSync(args.binaryPath)) {
        throw new CLIError(
          'binary-path was specified, but the file was not found.',
        );
      }
    }

    const {mode, scheme} = await getConfiguration(
      xcodeProject,
      sourceDir,
      args,
    );

    if (platformName === 'macos') {
      buildProject(xcodeProject, platformName, undefined, mode, scheme, args);
      return;
    }

    const sdkNames = getSDKNamefromPlatform(platformName);
    const devices = await listDevices(sdkNames);

    const availableDevices = devices.filter(
      ({isAvailable}) => isAvailable === true,
    );

    if (availableDevices.length === 0) {
      return logger.error(
        `${platformReadableName} devices or simulators not detected. Install simulators via Xcode or connect a physical ${platformReadableName} device`,
      );
    }

    if (args.listDevices || args.interactive) {
      if (args.device || args.udid) {
        logger.warn(
          `Both ${
            args.device ? 'device' : 'udid'
          } and "list-devices" parameters were passed to "run" command. We will list available devices and let you choose from one.`,
        );
      }

      const packageJson = getPackageJson(ctx.root);
      const preferredDevice = cacheManager.get(
        packageJson.name,
        'lastUsedIOSDeviceId',
      );

      const selectedDevice = await promptForDeviceSelection(
        availableDevices,
        preferredDevice,
      );

      if (!selectedDevice) {
        throw new CLIError(
          `Failed to select device, please try to run app without ${
            args.listDevices ? 'list-devices' : 'interactive'
          } command.`,
        );
      } else {
        if (selectedDevice.udid !== preferredDevice) {
          cacheManager.set(
            packageJson.name,
            'lastUsedIOSDeviceId',
            selectedDevice.udid,
          );
        }
      }

      if (selectedDevice.type === 'simulator') {
        return runOnSimulator(
          xcodeProject,
          platformName,
          mode,
          scheme,
          args,
          selectedDevice,
        );
      } else {
        return runOnDevice(
          selectedDevice,
          platformName,
          mode,
          scheme,
          xcodeProject,
          args,
        );
      }
    }

    if (!args.device && !args.udid && !args.simulator) {
      const bootedDevices = availableDevices.filter(
        ({type}) => type === 'device',
      );

      const simulators = getSimulators();
      const bootedSimulators = Object.keys(simulators.devices)
        .map((key) => simulators.devices[key])
        .reduce((acc, val) => acc.concat(val), [])
        .filter(({state}) => state === 'Booted');

      const booted = [...bootedDevices, ...bootedSimulators];
      if (booted.length === 0) {
        logger.info(
          'No booted devices or simulators found. Launching first available simulator...',
        );
        return runOnSimulator(
          xcodeProject,
          platformName,
          mode,
          scheme,
          args,
          fallbackSimulator,
        );
      }

      logger.info(`Found booted ${booted.map(({name}) => name).join(', ')}`);

      for (const device of devices) {
        await runOnDevice(
          device,
          platformName,
          mode,
          scheme,
          xcodeProject,
          args,
        );
      }

      for (const simulator of bootedSimulators) {
        await runOnSimulator(
          xcodeProject,
          platformName,
          mode,
          scheme,
          args,
          simulator || fallbackSimulator,
        );
      }
    }

    if (args.device && args.udid) {
      return logger.error(
        'The `device` and `udid` options are mutually exclusive.',
      );
    }

    if (args.udid) {
      const device = availableDevices.find((d) => d.udid === args.udid);
      if (!device) {
        return logger.error(
          `Could not find a device with udid: "${chalk.bold(
            args.udid,
          )}". ${printFoundDevices(availableDevices)}`,
        );
      }
      if (device.type === 'simulator') {
        return runOnSimulator(
          xcodeProject,
          platformName,
          mode,
          scheme,
          args,
          fallbackSimulator,
        );
      } else {
        return runOnDevice(
          device,
          platformName,
          mode,
          scheme,
          xcodeProject,
          args,
        );
      }
    } else if (args.device) {
      const physicalDevices = availableDevices.filter(
        ({type}) => type !== 'simulator',
      );
      const device = matchingDevice(physicalDevices, args.device);
      if (device) {
        return runOnDevice(
          device,
          platformName,
          mode,
          scheme,
          xcodeProject,
          args,
        );
      }
    } else {
      runOnSimulator(
        xcodeProject,
        platformName,
        mode,
        scheme,
        args,
        fallbackSimulator,
      );
    }
  };

export default createRun;