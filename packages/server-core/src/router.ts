//! The relay as one function, for callers written before the kernel (`relay.ts`) was split
//! into `edge` and `inRoom`. It is the kernel's `handle`, with the same options.

import {createRelay} from './relay.js';
import type {RelayOptions} from './relay.js';
import type {RequestContext} from './ports.js';

export type RouterOptions = RelayOptions;

export function createRouter(options: RouterOptions): (request: Request, context?: RequestContext) => Promise<Response> {
    const relay = createRelay(options);
    return (request, context) => relay.handle(request, context);
}
