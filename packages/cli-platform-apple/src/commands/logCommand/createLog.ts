import {CLIError, logger, prompt} from '@react-native-community/cli-tools';
import {Config, ProjectConfig} from '@react-native-community/cli-types';
import {spawnSync} from 'child_process';
import os from 'os';
import path from 'path';
import getSimulators from '../../tools/getSimulators';
import listDevices from '../../tools/listDevices';
import getPlatformReadableName from '../runCommand/getPlatformReadableName';
import getSDKNamefromPlatform from '../runCommand/getSDKNameFromPlatform';
import {BuilderCommand} from '../../types';

/**
 * Starts Apple device syslog tail
 */

type Args = {
  interactive: boolean;
};

const createLog =
  ({platformName}: BuilderCommand) =>
  async (_: Array<string>, ctx: Config, args: Args) => {
    const platform = ctx.project[platformName] as ProjectConfig['ios'];
    const platformReadableName = getPlatformReadableName(platformName);

    if (platform === undefined) {
      throw new CLIError(`Unable to find ${platform} platform config`);
    }

    // Here we're using two command because first command `xcrun simctl list --json devices` outputs `state` but doesn't return `available`. But second command `xcrun xcdevice list` outputs `available` but doesn't output `state`. So we need to connect outputs of both commands.
    const simulators = getSimulators();
    const bootedSimulators = Object.keys(simulators.devices)
      .map((key) => simulators.devices[key])
      .reduce((acc, val) => acc.concat(val), [])
      .filter(({state}) => state === 'Booted');

    const sdkNames = getSDKNamefromPlatform(platformName);
    const devices = await listDevices(sdkNames);

    const availableSimulators = devices.filter(
      ({type, isAvailable}) => type === 'simulator' && isAvailable,
    );

    if (availableSimulators.length === 0) {
      logger.error('No simulators detected. Install simulators via Xcode.');
      return;
    }

    const bootedAndAvailableSimulators = bootedSimulators.map((booted) => {
      const available = availableSimulators.find(
        ({udid}) => udid === booted.udid,
      );
      return {...available, ...booted};
    });

    if (bootedAndAvailableSimulators.length === 0) {
      logger.error(
        `No booted and available ${platformReadableName} simulators found.`,
      );
      return;
    }

    if (args.interactive && bootedAndAvailableSimulators.length > 1) {
      const {udid} = await prompt({
        type: 'select',
        name: 'udid',
        message: `Select ${platformReadableName} simulators to tail logs from`,
        choices: bootedAndAvailableSimulators.map((simulator) => ({
          title: simulator.name,
          value: simulator.udid,
        })),
      });

      tailDeviceLogs(udid);
    } else {
      tailDeviceLogs(bootedAndAvailableSimulators[0].udid);
    }
  };

function tailDeviceLogs(udid: string) {
  const logDir = path.join(
    os.homedir(),
    'Library',
    'Logs',
    'CoreSimulator',
    udid,
    'asl',
  );

  const log = spawnSync('syslog', ['-w', '-F', 'std', '-d', logDir], {
    stdio: 'inherit',
  });

  if (log.error !== null) {
    throw log.error;
  }
}

export default createLog;