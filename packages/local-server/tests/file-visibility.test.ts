import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

type VisibilityReport = {passed: boolean; reports: Array<{runtime: string; files: number; visible: number; plan: string[]}>};

test('file visibility preserves retention and room boundaries while seeking the event-ID index', () => {
    const script = fileURLToPath(new URL('../../../scripts/check-file-visibility.mjs', import.meta.url));
    const report = JSON.parse(execFileSync(process.execPath, [script, '--node-only'], {encoding: 'utf8'})) as VisibilityReport;
    expect(report.passed).toBe(true);
    expect(report.reports.map((entry) => entry.files)).toEqual([241, 6000]);
    expect(report.reports[1]?.visible).toBe(3000);
}, 15_000);
