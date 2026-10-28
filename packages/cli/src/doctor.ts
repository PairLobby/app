//! `pairlobby doctor`: what this device would talk to and what that relay says it
//! can do, so "does this relay support X" has one place to look. Read only: it
//! sends one GET and changes nothing.

import {PairLobbyClient} from '@pairlobby/client';
import type {LocalStore} from '@pairlobby/client';
import {formatFileSize} from '@pairlobby/protocol';
import type {RelayFeature, RelayLimits, ServerDescription} from '@pairlobby/protocol';

import {UsageError} from './context.js';
import {activeEndpoint} from './endpoints.js';
import {accountToken} from './online.js';
import {json, out} from './render.js';
import {VERSION} from './version.js';

export type DoctorReport = {
    cli: string;
    relay: string;
    reachable: boolean;
    error?: string;
    description: ServerDescription | null;
    endpoint: {name: string; origin: string; loginMode: string; tokenSaved: boolean};
};

const LIMIT_LABELS: [keyof RelayLimits, string, boolean][] = [
    ['maxParticipants', 'participants', false],
    ['maxEventPayloadBytes', 'message', true],
    ['maxRetainedEvents', 'events kept', false],
    ['maxRetainedEventBytes', 'history kept', true],
    ['maxFileBytes', 'file', true],
    ['maxRetainedFileBytes', 'files kept', true]
];

/** Refuses up front what the relay says it cannot do. A relay that does not describe itself is given the benefit of the doubt. */
export async function requireRelayFeature(client: PairLobbyClient, feature: RelayFeature, what: string): Promise<void> {
    const features = (await client.describe())?.features;
    if (features && !features.includes(feature)) {
        throw new UsageError(`This relay (${client.serverUrl}) does not support ${what}. pairlobby doctor --server ${client.serverUrl} lists what it does.`);
    }
}

export async function doctorReport(store: LocalStore, relay: string): Promise<DoctorReport> {
    const endpoint = activeEndpoint(store);
    const report: DoctorReport = {cli: VERSION, relay, reachable: true, description: null, endpoint: {name: endpoint.name, origin: endpoint.origin, loginMode: endpoint.loginMode, tokenSaved: accountToken(store, endpoint) !== undefined}};
    try {
        report.description = await new PairLobbyClient(relay).describe(true);
    } catch (error) {
        report.reachable = false;
        report.error = error instanceof Error ? error.message : String(error);
    }
    return report;
}

function limitsLine(limits: RelayLimits): string {
    return LIMIT_LABELS.filter(([key]) => limits[key] !== undefined).map(([key, label, bytes]) => `${label} ${bytes ? formatFileSize(limits[key]!) : limits[key]!.toLocaleString('en-US')}`).join(', ');
}

export async function doctorCommand(store: LocalStore, relay: string, asJson: boolean): Promise<number> {
    const report = await doctorReport(store, relay);
    if (asJson) {
        json(report);
        return report.reachable ? 0 : 1;
    }
    const described = report.description;
    out(`CLI             ${report.cli}`);
    out(`Relay           ${report.relay}`);
    if (!report.reachable) {
        out(`Reachable       no: ${report.error}`);
    } else if (!described) {
        out('Reachable       yes');
        out('Description     none: an older relay, or one that does not describe itself');
    } else {
        out(`Relay version   ${described.version ?? 'not reported'}${described.protocol ? ` (protocol ${described.protocol})` : ''}`);
        const transport = described.transport;
        out(`Transport       ${transport ? `${transport.live}${transport.maxWaitMs ? ` (holds reads up to ${transport.maxWaitMs / 1000} s)` : ''}` : 'not reported'}`);
        out(`Features        ${described.features?.length ? described.features.join(', ') : 'none reported'}`);
        if (described.limits) {
            out(`New rooms       ${limitsLine(described.limits)}`);
        }
        if (described.shareUrls) {
            out(`Shared at       ${described.shareUrls.length ? described.shareUrls.join(', ') : 'this device only'}`);
        }
    }
    out(`Endpoint        ${report.endpoint.name} (${report.endpoint.origin}), login ${report.endpoint.loginMode}, token saved ${report.endpoint.tokenSaved ? 'yes' : 'no'}`);
    return report.reachable ? 0 : 1;
}
