import {CLIError, logger} from '@react-native-community/cli-tools';
import {Config, IOSProjectConfig} from '@react-native-community/cli-types';
import {spawnSync} from 'child_process';
import os from 'os';
import path from 'path';
import getSimulators from '../../tools/getSimulators';
import listDevices, {stripPlatform} from '../../tools/listDevices';
import {getPlatformInfo} from '../runCommand/getPlatformInfo';
import {BuilderCommand, Device} from '../../types';
import {supportedPlatforms} from '../../config/supportedPlatforms';
import {promptForDeviceToTailLogs} from '../../tools/prompts';

/**
 * Starts Apple device syslog tail
 */

type Args = {
  interactive: boolean;
};

const createLog =
  ({platformName}: BuilderCommand) =>
  async (_: Array<string>, ctx: Config, args: Args) => {
    const platformConfig = ctx.project[platformName] as IOSProjectConfig;
    const {readableName: platformReadableName} = getPlatformInfo(platformName);

    if (
      platformConfig === undefined ||
      supportedPlatforms[platformName] === undefined
    ) {
      throw new CLIError(`Unable to find ${platformName} platform config`);
    }

    // Here we're using two command because first command `xcrun simctl list --json devices` outputs `state` but doesn't return `available`. But second command `xcrun xcdevice list` outputs `available` but doesn't output `state`. So we need to connect outputs of both commands.
    const simulators = getSimulators();
    const bootedSimulators = Object.keys(simulators.devices)
      .map((key) => simulators.devices[key])
      .reduce((acc, val) => acc.concat(val), [])
      .filter(({state}) => state === 'Booted');

    const {sdkNames} = getPlatformInfo(platformName);
    const devices = await listDevices(sdkNames);

    const availableSimulators = devices.filter(
      ({type, isAvailable}) => type === 'simulator' && isAvailable,
    );

    if (availableSimulators.length === 0) {
      logger.error('No simulators detected. Install simulators via Xcode.');
      return;
    }

    const bootedAndAvailableSimulators = bootedSimulators
      .map((booted) => {
        const available = availableSimulators.find(
          ({udid}) => udid === booted.udid,
        );
        return {...available, ...booted};
      })
      .filter(({sdk}) => sdk && sdkNames.includes(stripPlatform(sdk)));

    if (bootedAndAvailableSimulators.length === 0) {
      logger.error(
        `No booted and available ${platformReadableName} simulators found.`,
      );
      return;
    }

    if (args.interactive && bootedAndAvailableSimulators.length > 1) {
      const udid = await promptForDeviceToTailLogs(
        platformReadableName,
        bootedAndAvailableSimulators,
      );

      const simulator = bootedAndAvailableSimulators.find(
        ({udid: deviceUDID}) => deviceUDID === udid,
      );

      if (!simulator) {
        throw new CLIError(
          `Unable to find simulator with udid: ${udid} in booted simulators`,
        );
      }

      tailDeviceLogs(simulator);
    } else {
      tailDeviceLogs(bootedAndAvailableSimulators[0]);
    }
  };

function tailDeviceLogs(device: Device) {
  const logDir = path.join(
    os.homedir(),
    'Library',
    'Logs',
    'CoreSimulator',
    device.udid,
    'asl',
  );

  logger.info(`Tailing logs for device ${device.name} (${device.udid})`);

  const log = spawnSync('syslog', ['-w', '-F', 'std', '-d', logDir], {
    stdio: 'inherit',
  });

  if (log.error !== null) {
    throw log.error;
  }
}

export default createLog;
