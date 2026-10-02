//! The interactive `pairlobby settings` menu: the same panel as a room's /settings,
//! hosted in its own screen and editing this device's preferences.

import blessed from 'blessed';
import type {Key} from 'node:readline';

import type {LocalStore} from '@pairlobby/client';

import {deviceSettingsPage} from './device-settings.js';
import {RoomPanel} from './room-panel.js';

type MenuKey = Key & {sequence?: string};

type MenuProgramOptions = {extended: boolean; debug: boolean};

export function runSettingsMenu(store: LocalStore): Promise<void> {
    return new Promise((resolve) => {
        const program: MenuProgramOptions = {extended: false, debug: false};
        const screen = blessed.screen({program: blessed.program(program), smartCSR: true, fullUnicode: true, title: 'PairLobby settings', warnings: false});
        let closed = false;
        const panel = new RoomPanel({screen, close: () => {
            if (closed) {
                return;
            }
            closed = true;
            screen.destroy();
            process.stdin.pause();
            resolve();
        }});
        screen.on('keypress', (character: string, key: MenuKey) => {
            // Blessed reports one Enter as both "enter" and "return"; act on it once.
            if (closed || (key.name === 'return' && key.sequence === '\r')) {
                return;
            }
            panel.key(character, key);
        });
        screen.on('resize', () => panel.render());
        screen.program.enableMouse();
        panel.show(deviceSettingsPage(store));
    });
}
