//! Which certificates this process trusts when it talks to a relay over HTTPS.
//!
//! Node trusts only its own bundled list. On a company network that inspects
//! encrypted traffic, every site is re-signed by the company's own root, which IT
//! installs in the operating system's store, not in Node. Without this the CLI
//! cannot reach the hosted service there at all. So the CLI also trusts what the
//! operating system trusts, as a browser does, and a file named explicitly.

import {readFileSync} from 'node:fs';
import tls from 'node:tls';

export type TrustReport = {applied: boolean; system: number; file: number; problem?: string};
type CertificateStore = 'default' | 'system';
type TrustApi = {getCACertificates?: (store: CertificateStore) => string[]; setDefaultCACertificates?: (certificates: string[]) => void};

/** Names a PEM file of extra roots to trust, for a root that is not in the operating system's store. */
export const CA_FILE_VARIABLE = 'PAIRLOBBY_CA_FILE';

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Every certificate in a PEM bundle. A file with none in it is a mistake worth saying. */
export function certificatesIn(pem: string): string[] {
    return pem.match(PEM) ?? [];
}

/**
 * Adds the operating system's roots, and `caFile`'s, to Node's own. Never removes
 * trust, and never throws: a store that cannot be read leaves things as they were,
 * with the reason in the report for whoever is diagnosing a connection.
 */
export function trustLocalCertificates(caFile = process.env[CA_FILE_VARIABLE], api: TrustApi = tls as TrustApi): TrustReport {
    const report: TrustReport = {applied: false, system: 0, file: 0};
    let extra: string[] = [];
    if (caFile) {
        try {
            extra = certificatesIn(readFileSync(caFile, 'utf8'));
            if (!extra.length) {
                report.problem = `${caFile} contains no PEM certificate`;
            }
        } catch {
            report.problem = `${caFile} could not be read`;
        }
    }
    if (!api.getCACertificates || !api.setDefaultCACertificates) {
        // Older Node cannot change its trust after starting; NODE_EXTRA_CA_CERTS is read before this code runs.
        if (extra.length) {
            report.problem = `this Node cannot load ${caFile} after starting; set NODE_EXTRA_CA_CERTS=${caFile} instead`;
        }
        return report;
    }
    let system: string[] = [];
    try {
        system = api.getCACertificates('system');
    } catch {
        // Not every platform exposes its store; Node's own list still applies.
    }
    const trusted = api.getCACertificates('default');
    const known = new Set(trusted);
    const added = [...system, ...extra].filter((certificate) => !known.has(certificate) && known.add(certificate));
    report.system = system.length;
    report.file = extra.length;
    if (added.length) {
        api.setDefaultCACertificates([...trusted, ...added]);
    }
    report.applied = true;
    return report;
}
